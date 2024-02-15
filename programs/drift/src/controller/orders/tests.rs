use anchor_lang::prelude::Pubkey;
use anchor_lang::Owner;

use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::MarketStatus;
use crate::state::state::{FeeStructure, FeeTier};
use crate::state::user::{Order, PerpPosition};

fn get_fee_structure() -> FeeStructure {
    let mut fee_tiers = [FeeTier::default(); 10];
    fee_tiers[0] = FeeTier {
        fee_numerator: 5,
        fee_denominator: 10000,
        maker_rebate_numerator: 3,
        maker_rebate_denominator: 10000,
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

fn get_oracle_map<'a>() -> OracleMap<'a> {
    OracleMap::empty()
}

pub mod fulfill_order_with_maker_order {
    use crate::controller::orders::fulfill_perp_order_with_match;
    use crate::controller::position::PositionDirection;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BASE_PRECISION_I64, BASE_PRECISION_U64,
        BID_ASK_SPREAD_PRECISION, PEG_PRECISION, PRICE_PRECISION, PRICE_PRECISION_I64,
        PRICE_PRECISION_U64, QUOTE_PRECISION_I64, QUOTE_PRECISION_U64,
    };
    use crate::math::oracle::OracleValidity;
    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::state::user::{Order, OrderType, PerpPosition, User, UserStats};

    use crate::create_account_info;
    use crate::test_utils::{
        create_account_info, get_account_bytes, get_orders, get_positions, get_pyth_price,
    };

    use super::*;
    use crate::state::oracle::HistoricalOracleData;
    use std::str::FromStr;

    #[test]
    fn long_taker_order_fulfilled_start_of_auction() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -100050000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I64
        );
        assert_eq!(taker_position.quote_break_even_amount, -100050000);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);
        assert_eq!(taker_stats.taker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, 100030000);
        assert_eq!(maker_position.quote_entry_amount, 100 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, 100030000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -20000);
        assert_eq!(market.amm.total_fee, 20000);
        assert_eq!(market.amm.total_fee_minus_distributions, 20000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
    }

    #[test]
    fn long_taker_order_fulfilled_middle_of_auction() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                price: 160 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 3_i64;
        let slot = 3_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -160080000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -160 * QUOTE_PRECISION_I64
        );
        assert_eq!(taker_position.quote_break_even_amount, -160080000);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 80000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 160 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, 160048000);
        assert_eq!(maker_position.quote_entry_amount, 160 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, 160048000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 48000);
        assert_eq!(maker_stats.maker_volume_30d, 160 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -32000);
        assert_eq!(market.amm.total_fee, 32000);
        assert_eq!(market.amm.total_fee_minus_distributions, 32000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 32000);
    }

    #[test]
    fn short_taker_order_fulfilled_start_of_auction() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 200 * PRICE_PRECISION_I64,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                price: 180 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, 179910000);
        assert_eq!(taker_position.quote_entry_amount, 180 * QUOTE_PRECISION_I64);
        assert_eq!(taker_position.quote_break_even_amount, 179910000);
        assert_eq!(taker_position.open_asks, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 90000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 180 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, -179946000);
        assert_eq!(
            maker_position.quote_entry_amount,
            -180 * QUOTE_PRECISION_I64
        );
        assert_eq!(maker_position.quote_break_even_amount, -179946000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_bids, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 54000);
        assert_eq!(maker_stats.maker_volume_30d, 180 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -36000);
        assert_eq!(market.amm.total_fee, 36000);
        assert_eq!(market.amm.total_fee_minus_distributions, 36000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 36000);
    }

    #[test]
    fn short_taker_order_fulfilled_middle_of_auction() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 200 * PRICE_PRECISION_I64,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                price: 140 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 3_i64;
        let slot = 3_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, 139930000);
        assert_eq!(taker_position.quote_entry_amount, 140 * QUOTE_PRECISION_I64);
        assert_eq!(taker_position.quote_break_even_amount, 139930000);
        assert_eq!(taker_position.open_asks, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 70000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 140 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, -139958000);
        assert_eq!(
            maker_position.quote_entry_amount,
            -140 * QUOTE_PRECISION_I64
        );
        assert_eq!(maker_position.quote_break_even_amount, -139958000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_bids, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 42000);
        assert_eq!(maker_stats.maker_volume_30d, 140 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -28000);
        assert_eq!(market.amm.total_fee, 28000);
        assert_eq!(market.amm.total_fee_minus_distributions, 28000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 28000);
    }

    #[test]
    fn long_taker_order_auction_price_does_not_satisfy_maker() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                price: 201 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 1_i64;
        let slot = 3_u64;

        let fee_structure = FeeStructure::test_default();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        let (base_asset_amount, _, _) = fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0);
    }

    #[test]
    fn short_taker_order_auction_price_does_not_satisfy_maker() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                auction_start_price: 200 * PRICE_PRECISION_I64,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                price: 99 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 1_i64;
        let slot = 3_u64;

        let fee_structure = FeeStructure::test_default();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        let (base_asset_amount, _, _) = fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0);
    }

    #[test]
    fn maker_taker_same_direction() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 200 * PRICE_PRECISION_I64,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                price: 200 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = FeeStructure::test_default();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        let (base_asset_amount, _, _) = fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0);
    }

    #[test]
    fn maker_taker_different_market_index() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                auction_start_price: 200 * PRICE_PRECISION_I64,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                price: 200 * PRICE_PRECISION_U64,
                auction_duration: 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = FeeStructure::test_default();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        let (base_asset_amount, _, _) = fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0);
    }

    #[test]
    fn long_taker_order_bigger_than_maker() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: 100 * BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                price: 120 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = FeeStructure::test_default();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -120120000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -120 * QUOTE_PRECISION_I64
        );
        assert_eq!(taker_position.quote_break_even_amount, -120120000);
        assert_eq!(taker_stats.taker_volume_30d, 120 * QUOTE_PRECISION_U64);

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, 120072000);
        assert_eq!(maker_position.quote_entry_amount, 120 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, 120072000);
        assert_eq!(maker_stats.maker_volume_30d, 120 * QUOTE_PRECISION_U64);

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -48000);
    }

    #[test]
    fn long_taker_order_smaller_than_maker() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: 100 * BASE_PRECISION_U64,
                price: 120 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = FeeStructure::test_default();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -120120000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -120 * QUOTE_PRECISION_I64
        );
        assert_eq!(taker_position.quote_break_even_amount, -120120000);
        assert_eq!(taker_stats.taker_volume_30d, 120 * QUOTE_PRECISION_U64);

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, 120072000);
        assert_eq!(maker_position.quote_entry_amount, 120 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, 120072000);
        assert_eq!(maker_stats.maker_volume_30d, 120 * QUOTE_PRECISION_U64);

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -48000);
    }

    #[test]
    fn double_dutch_auction() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 10,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 200 * PRICE_PRECISION_I64,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 10,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 5_i64;
        let slot = 5_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -150075000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -150 * QUOTE_PRECISION_I64
        );
        assert_eq!(taker_position.quote_break_even_amount, -150075000);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 75000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 150 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, 150045000);
        assert_eq!(maker_position.quote_entry_amount, 150 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, 150045000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 45000);
        assert_eq!(maker_stats.maker_volume_30d, 150 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -30000);
        assert_eq!(market.amm.total_fee, 30000);
        assert_eq!(market.amm.total_fee_minus_distributions, 30000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 30000);
    }

    #[test]
    fn taker_bid_crosses_maker_ask() {
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                price: 150 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 5_i64;
        let slot = 5_u64;

        let fee_structure = get_fee_structure();
        let (maker_key, taker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, 100030000);
        assert_eq!(maker_position.quote_entry_amount, 100 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, 100030000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -100050000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I64
        );
        assert_eq!(taker_position.quote_break_even_amount, -100050000);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -20000);
        assert_eq!(market.amm.total_fee, 20000);
        assert_eq!(market.amm.total_fee_minus_distributions, 20000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
    }

    #[test]
    fn taker_ask_crosses_maker_bid() {
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                price: 50 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 5_i64;
        let slot = 5_u64;

        let fee_structure = get_fee_structure();

        let (maker_key, taker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, -99970000);
        assert_eq!(
            maker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I64
        );
        assert_eq!(maker_position.quote_break_even_amount, -99970000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_bids, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker.orders[0], Order::default());
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, 99950000);
        assert_eq!(taker_position.quote_entry_amount, 100 * QUOTE_PRECISION_I64);
        assert_eq!(taker_position.quote_break_even_amount, 99950000);
        assert_eq!(taker_position.open_asks, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -20000);
        assert_eq!(market.amm.total_fee, 20000);
        assert_eq!(market.amm.total_fee_minus_distributions, 20000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
    }

    #[test]
    fn fallback_price_doesnt_cross_maker() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 0,
                auction_duration: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                price: 120 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                short_spread: (BID_ASK_SPREAD_PRECISION / 10) as u32,
                long_spread: (BID_ASK_SPREAD_PRECISION / 10) as u32,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };

        let now = 0_i64;
        let slot = 0_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        let (base_asset_amount, _, _) = fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0);
    }

    #[test]
    fn fallback_price_crosses_maker() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 0,
                auction_duration: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                price: 105 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                short_spread: (BID_ASK_SPREAD_PRECISION / 10) as u32,
                long_spread: (BID_ASK_SPREAD_PRECISION / 10) as u32,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                base_spread: 100,
                amm_jit_intensity: 0,
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

        let now = 0_i64;
        let slot = 0_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        let (base_asset_amount, _, _) = fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        assert_eq!(base_asset_amount, 1000000000);
    }

    #[test]
    fn taker_oracle_bid_crosses_maker_ask() {
        let now = 50000_i64;
        let slot = 50000_u64;

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Oracle,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                auction_start_price: 999 * PRICE_PRECISION_I64 / 10, // $99.9
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 10, // auction is 1 cent per slot
                slot: slot - 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut oracle_price = get_pyth_price(100, 6);
        oracle_price.curr_slot = slot - 10000;
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

        let mut market = PerpMarket::default_test();
        market.amm.historical_oracle_data.last_oracle_price_twap = 999 * PRICE_PRECISION_I64 / 10;
        market.amm.historical_oracle_data.last_oracle_price_twap_ts = now - 1;
        market.amm.oracle = oracle_price_key;

        let (opd, ov) = oracle_map
            .get_price_data_and_validity(
                &oracle_price_key,
                market.amm.historical_oracle_data.last_oracle_price_twap,
            )
            .unwrap();

        assert_eq!(opd.delay, 50000); // quite long time
        assert_eq!(ov, OracleValidity::StaleForMargin);

        let fee_structure = get_fee_structure();
        let (maker_key, taker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let oracle_price = 100 * PRICE_PRECISION_I64;

        let valid_oracle_price = Some(oracle_price);
        let taker_limit_price = taker.orders[0]
            .get_limit_price(valid_oracle_price, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            Some(oracle_price),
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut oracle_map,
        )
        .unwrap();

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, 100030000);
        assert_eq!(maker_position.quote_entry_amount, 100 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, 100030000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -100050000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I64
        );
        assert_eq!(taker_position.quote_break_even_amount, -100050000);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -20000);
        assert_eq!(market.amm.total_fee, 20000);
        assert_eq!(market.amm.total_fee_minus_distributions, 20000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
    }

    #[test]
    fn taker_oracle_bid_after_auction_crosses_maker_ask() {
        let now = 11_i64;
        let slot = 11_u64;

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Oracle,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                auction_start_price: 0,
                auction_end_price: 0,
                oracle_price_offset: (100 * PRICE_PRECISION_I64) as i32,
                auction_duration: 10,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut oracle_price = get_pyth_price(99, 6);
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

        let taker_price = taker.orders[0]
            .get_limit_price(
                Some(oracle_map.get_price_data(&oracle_price_key).unwrap().price),
                None,
                slot,
                1,
            )
            .unwrap();
        assert_eq!(taker_price, Some(199000000)); // $51

        let mut market = PerpMarket::default_test();
        market.amm.oracle = oracle_price_key;

        let fee_structure = get_fee_structure();
        let (maker_key, taker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let oracle_price = 100 * PRICE_PRECISION_I64;

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            Some(oracle_price),
            taker_price,
            now,
            slot,
            &fee_structure,
            &mut oracle_map,
        )
        .unwrap();

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, 100030000);
        assert_eq!(maker_position.quote_entry_amount, 100 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, 100030000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -100050000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I64
        );
        assert_eq!(taker_position.quote_break_even_amount, -100050000);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -20000);
        assert_eq!(market.amm.total_fee, 20000);
        assert_eq!(market.amm.total_fee_minus_distributions, 20000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
    }

    #[test]
    fn taker_oracle_ask_crosses_maker_bid() {
        let now = 5_i64;
        let slot = 5_u64;

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Oracle,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                auction_start_price: 0,
                auction_end_price: -100 * PRICE_PRECISION_I64,
                auction_duration: 10,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

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

        let mut market = PerpMarket::default_test();
        market.amm.oracle = oracle_price_key;

        let fee_structure = get_fee_structure();

        let (maker_key, taker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let valid_oracle_price = Some(oracle_map.get_price_data(&oracle_price_key).unwrap().price);
        let taker_limit_price = taker.orders[0]
            .get_limit_price(valid_oracle_price, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut oracle_map,
        )
        .unwrap();

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, -99970000);
        assert_eq!(
            maker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I64
        );
        assert_eq!(maker_position.quote_break_even_amount, -99970000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_bids, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker.orders[0], Order::default());
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, 99950000);
        assert_eq!(taker_position.quote_entry_amount, 100 * QUOTE_PRECISION_I64);
        assert_eq!(taker_position.quote_break_even_amount, 99950000);
        assert_eq!(taker_position.open_asks, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -20000);
        assert_eq!(market.amm.total_fee, 20000);
        assert_eq!(market.amm.total_fee_minus_distributions, 20000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
    }

    #[test]
    fn taker_oracle_ask_after_action_crosses_maker_bid() {
        let now = 11_i64;
        let slot = 11_u64;

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Oracle,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                auction_start_price: 0,
                auction_end_price: 0,
                oracle_price_offset: (-50 * PRICE_PRECISION_I64) as i32,
                auction_duration: 10,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut oracle_price = get_pyth_price(101, 6);
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

        let mut market = PerpMarket::default_test();
        market.amm.oracle = oracle_price_key;

        let taker_price = taker.orders[0]
            .get_limit_price(
                Some(oracle_map.get_price_data(&oracle_price_key).unwrap().price),
                None,
                slot,
                1,
            )
            .unwrap();
        assert_eq!(taker_price, Some(51000000)); // $51

        let fee_structure = get_fee_structure();

        let (maker_key, taker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_price,
            now,
            slot,
            &fee_structure,
            &mut oracle_map,
        )
        .unwrap();

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, -99970000);
        assert_eq!(
            maker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I64
        );
        assert_eq!(maker_position.quote_break_even_amount, -99970000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_bids, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker.orders[0], Order::default());
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, 99950000);
        assert_eq!(taker_position.quote_entry_amount, 100 * QUOTE_PRECISION_I64);
        assert_eq!(taker_position.quote_break_even_amount, 99950000);
        assert_eq!(taker_position.open_asks, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -20000);
        assert_eq!(market.amm.total_fee, 20000);
        assert_eq!(market.amm.total_fee_minus_distributions, 20000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
    }

    #[test]
    fn limit_auction_crosses_maker_bid() {
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                price: 10 * PRICE_PRECISION_U64,
                auction_end_price: 10 * PRICE_PRECISION_I64,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 10,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 5_i64;
        let slot = 5_u64;

        assert_eq!(
            taker.orders[0]
                .get_limit_price(None, None, slot, market.amm.order_tick_size)
                .unwrap(),
            Some(55000000)
        );

        let fee_structure = get_fee_structure();

        let (maker_key, taker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, -99970000);
        assert_eq!(
            maker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I64
        );
        assert_eq!(maker_position.quote_break_even_amount, -99970000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_bids, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker.orders[0], Order::default());
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, 99950000);
        assert_eq!(taker_position.quote_entry_amount, 100 * QUOTE_PRECISION_I64);
        assert_eq!(taker_position.quote_break_even_amount, 99950000);
        assert_eq!(taker_position.open_asks, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -20000);
        assert_eq!(market.amm.total_fee, 20000);
        assert_eq!(market.amm.total_fee_minus_distributions, 20000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
    }

    #[test]
    fn limit_auction_crosses_maker_ask() {
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                price: 150 * PRICE_PRECISION_U64,
                auction_start_price: 50 * PRICE_PRECISION_I64,
                auction_end_price: 150 * PRICE_PRECISION_I64,
                auction_duration: 10,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut market = PerpMarket::default_test();

        let now = 5_i64;
        let slot = 5_u64;

        assert_eq!(
            taker.orders[0]
                .get_limit_price(None, None, slot, market.amm.order_tick_size)
                .unwrap(),
            Some(100000000)
        );

        let fee_structure = get_fee_structure();
        let (maker_key, taker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_limit_price = taker.orders[0]
            .get_limit_price(None, None, slot, market.amm.order_tick_size)
            .unwrap();

        fulfill_perp_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            taker_limit_price,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
        )
        .unwrap();

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, 100030000);
        assert_eq!(maker_position.quote_entry_amount, 100 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, 100030000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -100050000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I64
        );
        assert_eq!(taker_position.quote_break_even_amount, -100050000);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount, -20000);
        assert_eq!(market.amm.total_fee, 20000);
        assert_eq!(market.amm.total_fee_minus_distributions, 20000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
    }
}

pub mod fulfill_order {
    use std::str::FromStr;
    use std::u64;

    use crate::controller::orders::{fulfill_perp_order, validate_market_within_price_band};
    use crate::controller::position::PositionDirection;
    use crate::create_anchor_account_info;
    use crate::error::ErrorCode;
    use crate::get_orders;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I64, BASE_PRECISION_U64,
        BID_ASK_SPREAD_PRECISION_I64, PEG_PRECISION, PRICE_PRECISION, PRICE_PRECISION_I64,
        PRICE_PRECISION_U64, QUOTE_PRECISION_I64, QUOTE_PRECISION_U64, SPOT_BALANCE_PRECISION_U64,
        SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::math::margin::calculate_margin_requirement_and_total_collateral_and_liability_info;
    use crate::state::fill_mode::FillMode;
    use crate::state::margin_calculation::MarginContext;
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::state::{OracleGuardRails, State, ValidityGuardRails};
    use crate::state::user::{OrderStatus, OrderType, SpotPosition, User, UserStats};
    use crate::state::user_map::{UserMap, UserStatsMap};
    use crate::test_utils::*;
    use crate::test_utils::{get_orders, get_positions, get_pyth_price, get_spot_positions};
    use crate::{create_account_info, PERCENTAGE_PRECISION_U64};

    use super::*;

    #[test]
    fn validate_market_within_price_band_tests() {
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
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
                oracle: oracle_price_key,
                base_spread: 100,
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
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let mut state = State {
            oracle_guard_rails: OracleGuardRails {
                validity: ValidityGuardRails {
                    slots_before_stale_for_amm: 10,     // 5s
                    slots_before_stale_for_margin: 120, // 60s
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                ..OracleGuardRails::default()
            },
            ..State::default()
        };

        // valid initial state
        assert!(validate_market_within_price_band(&market, &state, true, None).unwrap());

        // twap_5min $50 and mark $100 breaches 10% divergence -> failure
        market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_5min = 50 * PRICE_PRECISION as i64;
        assert!(validate_market_within_price_band(&market, &state, true, None).is_err());

        // within 60% ok -> success
        state
            .oracle_guard_rails
            .price_divergence
            .mark_oracle_percent_divergence = 6 * PERCENTAGE_PRECISION_U64 / 10;
        assert!(validate_market_within_price_band(&market, &state, true, None).unwrap());

        // twap_5min $20 and mark $100 breaches 60% divergence -> failure
        market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_5min = 20 * PRICE_PRECISION as i64;
        assert!(validate_market_within_price_band(&market, &state, true, None).is_err());

        // twap_5min $20 and mark $100 but risk reduction when already breached -> success
        market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_5min = 20 * PRICE_PRECISION as i64;
        assert!(validate_market_within_price_band(
            &market,
            &state,
            false,
            Some(BID_ASK_SPREAD_PRECISION_I64 * 77 / 100)
        )
        .unwrap());

        // twap_5min $20 and mark $100 but risk reduction when not already breached -> failure
        market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_5min = 20 * PRICE_PRECISION as i64;
        assert!(validate_market_within_price_band(
            &market,
            &state,
            false,
            Some(BID_ASK_SPREAD_PRECISION_I64 * 51 / 100)
        )
        .is_err());
    }

    #[test]
    fn fulfill_with_amm_and_maker() {
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
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 0, // 1 basis point
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
        market.amm.max_base_asset_reserve = u128::MAX;
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
                auction_duration: 0,
                price: 150 * PRICE_PRECISION_U64,
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

        let maker_key = Pubkey::default();
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
                price: 100_010_000 * PRICE_PRECISION_U64 / 1_000_000, // .01 worse than amm
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
        create_anchor_account_info!(maker, User, maker_account_info);
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
            &[(
                Pubkey::default(),
                0,
                100_010_000 * PRICE_PRECISION_U64 / 1_000_000,
            )],
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
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -100306387);
        assert_eq!(taker_position.quote_entry_amount, -100256258);
        assert_eq!(taker_position.quote_break_even_amount, -100306387);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50129);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100256237);
        assert_eq!(taker.orders[0], Order::default());

        let maker = makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_stats = maker_and_referrer_stats
            .get_ref_mut(&maker_authority)
            .unwrap();
        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64 / 2);
        assert_eq!(maker_position.quote_break_even_amount, 50_020_001);
        assert_eq!(maker_position.quote_entry_amount, 50_005_000);
        assert_eq!(maker_position.quote_asset_amount, 50_020_001); // 50_005_000 + 50_005_000 * .0003
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15001);
        assert_eq!(maker_stats.maker_volume_30d, 50_005_000);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(filler_stats.filler_volume_30d, 100_256_237);
        assert_eq!(filler.perp_positions[0].quote_asset_amount, 5012);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.base_asset_amount_with_amm, 500000000);
        assert_eq!(market_after.amm.base_asset_amount_long, 1000000000);
        assert_eq!(market_after.amm.base_asset_amount_short, -500000000);
        assert_eq!(market_after.amm.quote_asset_amount, -50281374);

        let expected_market_fee = ((taker_stats.fees.total_fee_paid
            - (maker_stats.fees.total_fee_rebate
                + filler.perp_positions[0].quote_asset_amount as u64))
            as i128)
            + 1; //todo

        // assert_eq!(expected_market_fee, 35100);
        assert_eq!(market_after.amm.total_fee, expected_market_fee);
        assert_eq!(
            market_after.amm.total_fee_minus_distributions,
            expected_market_fee
        );
        assert_eq!(
            market_after.amm.net_revenue_since_last_funding,
            expected_market_fee as i64
        );

        let reserve_price = market_after.amm.reserve_price().unwrap();
        assert_eq!(reserve_price, 101_007_550);
    }

    #[test]
    fn fulfill_with_multiple_maker_orders() {
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
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 0, // 1 basis point
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
        market.amm.max_base_asset_reserve = u128::MAX;
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
                auction_duration: 0,
                price: 150 * PRICE_PRECISION_U64,
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

        let maker_key = Pubkey::default();
        let maker_authority =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let mut maker = User {
            authority: maker_authority,
            orders: get_orders!(
                Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: BASE_PRECISION_U64 / 2,
                    price: 90 * PRICE_PRECISION_U64,
                    ..Order::default()
                },
                Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: BASE_PRECISION_U64 / 2,
                    price: 95 * PRICE_PRECISION_U64, // .01 worse than amm
                    ..Order::default()
                }
            ),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 2,
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
        create_anchor_account_info!(maker, User, maker_account_info);
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
            &[
                (maker_key, 0, 90 * PRICE_PRECISION_U64),
                (maker_key, 1, 95 * PRICE_PRECISION_U64),
            ],
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            100 * PRICE_PRECISION_U64,
            Some(market.amm.historical_oracle_data.last_oracle_price),
            now,
            slot,
            10,
            true,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION_U64);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -92546250);
        assert_eq!(taker_position.quote_entry_amount, -92500000);
        assert_eq!(taker_position.quote_break_even_amount, -92546250);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);

        let maker = makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, 92527750);
        assert_eq!(maker_position.quote_entry_amount, 92500000);
        assert_eq!(maker_position.quote_asset_amount, 92527750);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
    }

    #[test]
    fn fulfill_with_maker_then_amm() {
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
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100_050 * PEG_PRECISION / 1000,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 100, // 1 basis point
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
        market.amm.max_base_asset_reserve = u128::MAX;
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
                price: 150 * PRICE_PRECISION_U64,
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

        let maker_key = Pubkey::default();
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
                price: 100_010_000 * PRICE_PRECISION_U64 / 1_000_000, // .01 worse than amm
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
        create_anchor_account_info!(maker, User, maker_account_info);
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
            &[(maker_key, 0, 100_010_000 * PRICE_PRECISION_U64 / 1_000_000)],
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
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -100331524);
        assert_eq!(taker_position.quote_entry_amount, -100281382);
        assert_eq!(taker_position.quote_break_even_amount, -100331524);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50142);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100281362);
        assert_eq!(taker.orders[0], Order::default());

        let maker = makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_stats = maker_and_referrer_stats
            .get_ref_mut(&maker_authority)
            .unwrap();
        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64 / 2);
        assert_eq!(maker_position.quote_break_even_amount, 50_020_001);
        assert_eq!(maker_position.quote_entry_amount, 50_005_000);
        assert_eq!(maker_position.quote_asset_amount, 50_020_001); // 50_005_000 + 50_005_000 * .0003
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15001);
        assert_eq!(maker_stats.maker_volume_30d, 50_005_000);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(filler_stats.filler_volume_30d, 100281362);
        assert_eq!(filler.perp_positions[0].quote_asset_amount, 5013);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.base_asset_amount_with_amm, 500000000);
        assert_eq!(market_after.amm.base_asset_amount_long, 1000000000);
        assert_eq!(market_after.amm.base_asset_amount_short, -500000000);
        assert_eq!(market_after.amm.quote_asset_amount, -50306510);

        let expected_market_fee = (taker_stats.fees.total_fee_paid
            - (maker_stats.fees.total_fee_rebate
                + filler.perp_positions[0].quote_asset_amount as u64))
            as i128;
        assert_eq!(expected_market_fee, 30128);
        assert_eq!(market_after.amm.total_fee, expected_market_fee);
        assert_eq!(
            market_after.amm.total_fee_minus_distributions,
            expected_market_fee
        );
        assert_eq!(
            market_after.amm.net_revenue_since_last_funding,
            expected_market_fee as i64
        );

        let reserve_price = market_after.amm.reserve_price().unwrap();
        assert_eq!(reserve_price, 101_058_054);
    }

    #[test]
    fn fulfill_with_maker_with_auction_incomplete() {
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
                order_step_size: 1,
                order_tick_size: 1,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                max_fill_reserve_fraction: 1,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
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

        let mut oracle_map = get_oracle_map();

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
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

        let maker_key = Pubkey::default();
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
        create_anchor_account_info!(maker, User, maker_account_info);
        let makers_and_referrers = UserMap::load_one(&maker_account_info).unwrap();

        let now = 0_i64;
        let slot = 0_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, _, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats {
            authority: maker_authority,
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_and_referrer_stats = UserStatsMap::load_one(&maker_stats_account_info).unwrap();

        let (base_asset_amount, _) = fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[(maker_key, 0, 100 * PRICE_PRECISION_U64)],
            &mut None,
            &filler_key,
            &mut None,
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            None,
            now,
            slot,
            10,
            true,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION_U64 / 2);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64 / 2);
        assert_eq!(taker_position.quote_asset_amount, -50025000);
        assert_eq!(taker_position.quote_entry_amount, -50 * QUOTE_PRECISION_I64);
        assert_eq!(taker_position.quote_break_even_amount, -50025000);
        assert_eq!(taker_position.open_bids, BASE_PRECISION_I64 / 2);
        assert_eq!(taker_position.open_orders, 1);
        assert_eq!(taker_stats.fees.total_fee_paid, 25000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 50 * QUOTE_PRECISION_U64);

        let maker = makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_stats = maker_and_referrer_stats
            .get_ref_mut(&maker_authority)
            .unwrap();
        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64 / 2);
        assert_eq!(maker_position.quote_asset_amount, 50015000);
        assert_eq!(maker_position.quote_entry_amount, 50 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, 50015000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15000);
        assert_eq!(maker_stats.maker_volume_30d, 50 * QUOTE_PRECISION_U64);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market_after.amm.base_asset_amount_long, 500000000);
        assert_eq!(market_after.amm.base_asset_amount_short, -500000000);
        assert_eq!(market_after.amm.quote_asset_amount, -10000);
        assert_eq!(market_after.amm.total_fee, 10000);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 10000);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 10000);
    }

    #[test]
    fn fulfill_with_amm_end_of_auction() {
        let now = 0_i64;
        let slot = 6_u64;

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
                max_slippage_ratio: 10,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                oracle: oracle_price_key,
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
        market.amm.max_base_asset_reserve = u128::MAX;
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
                auction_duration: 5,
                price: 150 * PRICE_PRECISION_U64,
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

        let fee_structure = get_fee_structure();

        let (taker_key, _, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &UserMap::empty(),
            &UserStatsMap::empty(),
            &[],
            &mut None,
            &filler_key,
            &mut None,
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
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -104133674);
        assert_eq!(taker_position.quote_entry_amount, -104081633);
        assert_eq!(taker_position.quote_break_even_amount, -104133674);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 52041);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 104081633);
        assert_eq!(taker.orders[0], Order::default());

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.base_asset_amount_with_amm, 1000000000);
        assert_eq!(market_after.amm.base_asset_amount_long, 1000000000);
        assert_eq!(market_after.amm.base_asset_amount_short, 0);
        assert_eq!(market_after.amm.quote_asset_amount, -104133674);
        assert_eq!(market_after.amm.total_fee, 3123572);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 3123572);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 3123572);
    }

    #[test]
    fn maker_position_reducing_above_maintenance_check() {
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
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 0, // 1 basis point
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            number_of_users_with_base: 1,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
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
                auction_duration: 0,
                price: 150 * PRICE_PRECISION_U64,
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

        let maker_key = Pubkey::default();
        let maker_authority =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let mut maker = User {
            authority: maker_authority,
            orders: get_orders!(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: 2 * BASE_PRECISION_U64,
                price: 100 * PRICE_PRECISION_U64, // .01 worse than amm
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64,
                open_orders: 1,
                open_asks: -2 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 501 * SPOT_BALANCE_PRECISION_U64 / 100,
                ..SpotPosition::default()
            }),
            ..User::default()
        };
        create_anchor_account_info!(maker, User, maker_account_info);
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

        let result = fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[(maker_key, 0, 95 * PRICE_PRECISION_U64)],
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            100 * PRICE_PRECISION_U64,
            Some(market.amm.historical_oracle_data.last_oracle_price),
            now,
            slot,
            10,
            true,
            FillMode::Fill,
        );

        assert!(result.is_ok());

        let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &maker,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(0),
        )
        .unwrap();

        assert_eq!(
            margin_calc.margin_requirement,
            margin_calc.total_collateral as u128
        );
    }

    #[test]
    fn maker_insufficient_collateral() {
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
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 0, // 1 basis point
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
        market.amm.max_base_asset_reserve = u128::MAX;
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
                auction_duration: 0,
                price: 150 * PRICE_PRECISION_U64,
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

        let maker_key = Pubkey::default();
        let maker_authority =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let mut maker = User {
            authority: maker_authority,
            orders: get_orders!(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                price: 95 * PRICE_PRECISION_U64, // .01 worse than amm
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
                scaled_balance: 10 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };
        create_anchor_account_info!(maker, User, maker_account_info);
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

        let result = fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[(maker_key, 0, 95 * PRICE_PRECISION_U64)],
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            100 * PRICE_PRECISION_U64,
            Some(market.amm.historical_oracle_data.last_oracle_price),
            now,
            slot,
            10,
            true,
            FillMode::Fill,
        );

        assert_eq!(result, Err(ErrorCode::InsufficientCollateral));
    }

    #[test]
    fn fulfill_post_only_ask_with_amm() {
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
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 0, // 1 basis point
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

        let reserve_price_before = market.amm.reserve_price().unwrap();
        let bid_price = market.amm.bid_price(reserve_price_before).unwrap();
        println!("bid_price: {}", bid_price); // $100

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
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_duration: 0,
                price: 100 * PRICE_PRECISION_U64 - (PRICE_PRECISION_U64 / 10), // 99.9
                post_only: true,
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

        let makers_and_referrers = UserMap::empty();

        let mut filler = User::default();

        let fee_structure = get_fee_structure();

        let (taker_key, _, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let maker_and_referrer_stats = UserStatsMap::empty();

        let mut filler_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[],
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            reserve_price_before,
            Some(market.amm.historical_oracle_data.last_oracle_price),
            now,
            slot,
            0,
            true,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 35032000);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, -35032000);
        assert_eq!(taker_position.quote_asset_amount, 3500746);
        assert_eq!(taker_position.quote_entry_amount, 3499697);
        assert_eq!(taker_position.quote_break_even_amount, 3500746);
        assert_eq!(taker_stats.fees.total_fee_paid, 0);
        assert_eq!(taker_stats.fees.total_fee_rebate, 1049);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 0);
        assert_eq!(taker_stats.maker_volume_30d, 3499697);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.base_asset_amount_with_amm, -35032000);
        assert_eq!(market_after.amm.base_asset_amount_long, 0);
        assert_eq!(market_after.amm.base_asset_amount_short, -35032000);
        assert_eq!(market_after.amm.quote_asset_amount, 3500868);
        assert_eq!(market_after.amm.total_fee, 1105);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 1105);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 1105);

        let market_after = market_map.get_ref(&0).unwrap();
        let reserve_price = market_after.amm.reserve_price().unwrap();
        let bid_price = market_after.amm.bid_price(reserve_price).unwrap();
        assert_eq!(bid_price, 99929972); // ~ 99.9 * (1.0003)
    }

    #[test]
    fn fulfill_post_only_bid_with_amm() {
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
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 0, // 1 basis point
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

        let reserve_price_before = market.amm.reserve_price().unwrap();
        let bid_price = market.amm.bid_price(reserve_price_before).unwrap();
        println!("bid_price: {}", bid_price); // $100

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
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_duration: 0,
                price: 100 * PRICE_PRECISION_U64 + (PRICE_PRECISION_U64 / 10), // 100.1
                post_only: true,
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

        let makers_and_referrers = UserMap::empty();

        let mut filler = User::default();

        let fee_structure = get_fee_structure();

        let (taker_key, _, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let maker_and_referrer_stats = UserStatsMap::empty();

        let mut filler_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[],
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            reserve_price_before,
            Some(market.amm.historical_oracle_data.last_oracle_price),
            now,
            slot,
            0,
            true,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 34966000);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, 34966000);
        assert_eq!(taker_position.quote_asset_amount, -3499046);
        assert_eq!(taker_position.quote_entry_amount, -3500096);
        assert_eq!(taker_position.quote_break_even_amount, -3499046);
        assert_eq!(taker_stats.fees.total_fee_paid, 0);
        assert_eq!(taker_stats.fees.total_fee_rebate, 1050);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 0);
        assert_eq!(taker_stats.maker_volume_30d, 3500096);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.base_asset_amount_with_amm, 34966000);
        assert_eq!(market_after.amm.base_asset_amount_long, 34966000);
        assert_eq!(market_after.amm.base_asset_amount_short, 0);
        assert_eq!(market_after.amm.quote_asset_amount, -3498924);
        assert_eq!(market_after.amm.total_fee, 1100);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 1100);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 1100);

        let market_after = market_map.get_ref(&0).unwrap();
        let reserve_price = market_after.amm.reserve_price().unwrap();
        let ask_price = market_after.amm.ask_price(reserve_price).unwrap();
        assert_eq!(ask_price, 100069968); // ~ 100.1 * (0.9997)
    }

    // Add back if we check free collateral in fill again
    // #[test]
    // fn fulfill_with_negative_free_collateral() {
    //     let now = 0_i64;
    //     let slot = 6_u64;
    //
    //     let mut oracle_price = get_pyth_price(100, 6);
    //     let oracle_price_key =
    //         Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    //     let pyth_program = crate::ids::pyth_program::id();
    //     create_account_info!(
    //         oracle_price,
    //         &oracle_price_key,
    //         &pyth_program,
    //         oracle_account_info
    //     );
    //     let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();
    //
    //     let mut market = PerpMarket {
    //         amm: AMM {
    //             base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
    //             quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
    //             bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
    //             bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
    //             ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
    //             ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
    //             sqrt_k: 100 * AMM_RESERVE_PRECISION,
    //             peg_multiplier: 100 * PEG_PRECISION,
    //             max_slippage_ratio: 10,
    //             max_fill_reserve_fraction: 100,
    //             order_step_size: 10000000,
    //             order_tick_size: 1,
    //             oracle: oracle_price_key,
    //             historical_oracle_data: HistoricalOracleData {
    //                 last_oracle_price: (100 * PRICE_PRECISION) as i64,
    //                 last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
    //                 last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,
    //
    //                 ..HistoricalOracleData::default()
    //             },
    //             ..AMM::default()
    //         },
    //         margin_ratio_initial: 1000,
    //         margin_ratio_maintenance: 500,
    //         status: MarketStatus::Initialized,
    //         ..PerpMarket::default_test()
    //     };
    //     market.amm.max_base_asset_reserve = u128::MAX;
    //     market.amm.min_base_asset_reserve = 0;
    //
    //     create_anchor_account_info!(market, PerpMarket, market_account_info);
    //     let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();
    //
    //     let mut spot_market = SpotMarket {
    //         market_index: 0,
    //         oracle_source: OracleSource::QuoteAsset,
    //         cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
    //         decimals: 6,
    //         initial_asset_weight: SPOT_WEIGHT_PRECISION,
    //         maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
    //         ..SpotMarket::default()
    //     };
    //     create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    //     let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();
    //
    //     let mut taker = User {
    //         orders: get_orders(Order {
    //             market_index: 0,
    //             status: OrderStatus::Open,
    //             order_type: OrderType::Market,
    //             direction: PositionDirection::Long,
    //             base_asset_amount: 100 * BASE_PRECISION_U64,
    //             slot: 0,
    //             auction_start_price: 0,
    //             auction_end_price: 100 * PRICE_PRECISION_U64,
    //             auction_duration: 5,
    //             ..Order::default()
    //         }),
    //         perp_positions: get_positions(PerpPosition {
    //             market_index: 0,
    //             open_orders: 1,
    //             open_bids: 100 * BASE_PRECISION_I64,
    //             ..PerpPosition::default()
    //         }),
    //         spot_positions: get_spot_positions(SpotPosition {
    //             market_index: 0,
    //             balance_type: SpotBalanceType::Deposit,
    //             scaled_balance: SPOT_BALANCE_PRECISION_U64,
    //             ..SpotPosition::default()
    //         }),
    //         ..User::default()
    //     };
    //
    //     let _maker = User {
    //         orders: get_orders(Order {
    //             market_index: 0,
    //             post_only: true,
    //             order_type: OrderType::Limit,
    //             direction: PositionDirection::Short,
    //             base_asset_amount: BASE_PRECISION_U64 / 2,
    //             price: 100 * PRICE_PRECISION_U64,
    //             ..Order::default()
    //         }),
    //         perp_positions: get_positions(PerpPosition {
    //             market_index: 0,
    //             open_orders: 1,
    //             open_asks: -BASE_PRECISION_I64 / 2,
    //             ..PerpPosition::default()
    //         }),
    //         ..User::default()
    //     };
    //
    //     let fee_structure = get_fee_structure();
    //
    //     let (taker_key, _, filler_key) = get_user_keys();
    //
    //     let mut taker_stats = UserStats::default();
    //
    //     let (base_asset_amount, _) = fulfill_perp_order(
    //         &mut taker,
    //         0,
    //         &taker_key,
    //         &mut taker_stats,
    //         &mut None,
    //         &mut None,
    //         None,
    //         None,
    //         &mut None,
    //         &filler_key,
    //         &mut None,
    //         &mut None,
    //         &mut None,
    //         &spot_market_map,
    //         &market_map,
    //         &mut oracle_map,
    //         &fee_structure,
    //         0,
    //         None,
    //         now,
    //         slot,
    //         false,
    //         true,
    //     )
    //     .unwrap();
    //
    //     assert_eq!(base_asset_amount, 0);
    //
    //     assert_eq!(taker.perp_positions[0], PerpPosition::default());
    //     assert_eq!(taker.orders[0], Order::default());
    // }

    #[test]
    fn fulfill_users_with_multiple_orders_and_markets() {
        let mut sol_market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                order_step_size: 1,
                order_tick_size: 1,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: 100 * PRICE_PRECISION_I64,
                    ..HistoricalOracleData::default()
                },
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(sol_market, PerpMarket, sol_market_account_info);
        let mut btc_market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 20000 * PEG_PRECISION,
                order_step_size: 1,
                order_tick_size: 1,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: 20000 * PRICE_PRECISION_I64,
                    ..HistoricalOracleData::default()
                },
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            market_index: 1,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(btc_market, PerpMarket, btc_market_account_info);
        let market_map = PerpMarketMap::load_multiple(
            vec![&sol_market_account_info, &btc_market_account_info],
            true,
        )
        .unwrap();

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

        let mut oracle_map = get_oracle_map();

        let mut taker_orders = [Order::default(); 32];
        taker_orders[0] = Order {
            market_index: 0,
            status: OrderStatus::Open,
            order_type: OrderType::Market,
            direction: PositionDirection::Long,
            base_asset_amount: BASE_PRECISION_U64,
            slot: 0,
            auction_start_price: 100 * PRICE_PRECISION_I64,
            auction_end_price: 200 * PRICE_PRECISION_I64,
            auction_duration: 5,
            ..Order::default()
        };
        taker_orders[1] = Order {
            market_index: 1,
            status: OrderStatus::Open,
            order_type: OrderType::Market,
            direction: PositionDirection::Long,
            base_asset_amount: BASE_PRECISION_U64,
            slot: 0,
            auction_start_price: 20000 * PRICE_PRECISION_I64,
            auction_end_price: 20100 * PRICE_PRECISION_I64,
            auction_duration: 5,
            ..Order::default()
        };

        // Taker has sol order and position at index 0, btc at index 1
        let mut taker_positions = [PerpPosition::default(); 8];
        taker_positions[0] = PerpPosition {
            market_index: 0,
            open_orders: 1,
            open_bids: BASE_PRECISION_I64,
            ..PerpPosition::default()
        };
        taker_positions[1] = PerpPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: BASE_PRECISION_I64,
            ..PerpPosition::default()
        };

        let mut taker = User {
            orders: taker_orders,
            perp_positions: taker_positions,
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 10_000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        // Maker has sol order and position at index 1, btc at index 1
        let maker_key = Pubkey::default();
        let maker_authority =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let mut maker_orders = [Order::default(); 32];
        maker_orders[0] = Order {
            market_index: 1,
            post_only: true,
            order_type: OrderType::Limit,
            direction: PositionDirection::Short,
            base_asset_amount: BASE_PRECISION_U64 / 2,
            price: 20000 * PRICE_PRECISION_U64,
            ..Order::default()
        };
        maker_orders[1] = Order {
            market_index: 0,
            post_only: true,
            order_type: OrderType::Limit,
            direction: PositionDirection::Short,
            base_asset_amount: BASE_PRECISION_U64 / 2,
            price: 100 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let mut maker_positions = [PerpPosition::default(); 8];
        maker_positions[0] = PerpPosition {
            market_index: 1,
            open_orders: 1,
            open_asks: -BASE_PRECISION_I64 / 2,
            ..PerpPosition::default()
        };
        maker_positions[1] = PerpPosition {
            market_index: 0,
            open_orders: 1,
            open_asks: -BASE_PRECISION_I64 / 2,
            ..PerpPosition::default()
        };

        let mut maker = User {
            authority: maker_authority,
            orders: maker_orders,
            perp_positions: maker_positions,
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 10_000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };
        create_anchor_account_info!(maker, User, maker_account_info);
        let makers_and_referrers = UserMap::load_one(&maker_account_info).unwrap();

        // random
        let now = 1; //80080880_i64;
        let slot = 0; //7893275_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, _, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats {
            authority: maker_authority,
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_and_referrer_stats = UserStatsMap::load_one(&maker_stats_account_info).unwrap();

        let taker_before = taker;
        let maker_before = maker;
        let (base_asset_amount, _) = fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[(maker_key, 1, 100 * PRICE_PRECISION_U64)],
            &mut None,
            &filler_key,
            &mut None,
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            None,
            now,
            slot,
            10,
            true,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION_U64 / 2);

        let taker_position = &taker.perp_positions[0].clone();
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64 / 2);
        assert_eq!(taker_position.quote_asset_amount, -50025000);
        assert_eq!(taker_position.quote_entry_amount, -50 * QUOTE_PRECISION_I64);
        assert_eq!(taker_position.quote_break_even_amount, -50025000);
        assert_eq!(taker_position.open_bids, BASE_PRECISION_I64 / 2);
        assert_eq!(taker_position.open_orders, 1);
        assert_eq!(taker_stats.fees.total_fee_paid, 25000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 50 * QUOTE_PRECISION_U64);

        let taker_order = &taker.orders[0].clone();
        assert_eq!(taker_order.base_asset_amount_filled, BASE_PRECISION_U64 / 2);
        assert_eq!(taker_order.quote_asset_amount_filled, 50000000);

        // BTC Market shouldnt be affected
        assert_eq!(taker.perp_positions[1], taker_before.perp_positions[1]);
        assert_eq!(taker.orders[1], taker_before.orders[1]);

        let maker = makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_stats = maker_and_referrer_stats
            .get_ref_mut(&maker_authority)
            .unwrap();
        let maker_position = &maker.perp_positions[1];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64 / 2);
        assert_eq!(maker_position.quote_asset_amount, 50015000);
        assert_eq!(maker_position.quote_entry_amount, 50 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, 50015000);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15000);
        assert_eq!(maker_stats.maker_volume_30d, 50 * QUOTE_PRECISION_U64);

        assert_eq!(maker.orders[1], Order::default());

        // BTC Market shouldnt be affected
        assert_eq!(maker.perp_positions[0], maker_before.perp_positions[0]);
        assert_eq!(maker.orders[0], maker_before.orders[0]);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market_after.amm.base_asset_amount_long, 500000000);
        assert_eq!(market_after.amm.base_asset_amount_short, -500000000);
        assert_eq!(market_after.amm.quote_asset_amount, -10000);
        assert_eq!(market_after.amm.total_fee, 10000);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 10000);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 10000);

        assert_eq!(market_after.amm.last_mark_price_twap_ts, 1);
        assert_eq!(
            market_after
                .amm
                .historical_oracle_data
                .last_oracle_price_twap_ts,
            0
        );
        assert_eq!(market_after.amm.last_ask_price_twap, 50000000);
        assert_eq!(market_after.amm.last_bid_price_twap, 50000000);
        assert_eq!(market_after.amm.last_mark_price_twap, 50000000);
        assert_eq!(market_after.amm.last_mark_price_twap_5min, 333332);
        assert_eq!(
            market_after
                .amm
                .historical_oracle_data
                .last_oracle_price_twap,
            0
        );
        assert_eq!(
            market_after
                .amm
                .historical_oracle_data
                .last_oracle_price_twap_5min,
            0
        );
    }
}

pub mod fill_order {
    use std::str::FromStr;

    use anchor_lang::prelude::{AccountLoader, Clock};

    use crate::controller::orders::fill_perp_order;
    use crate::controller::position::PositionDirection;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I64, BASE_PRECISION_U64, PEG_PRECISION,
        PRICE_PRECISION_I64, PRICE_PRECISION_U64, SPOT_BALANCE_PRECISION_U64,
        SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::oracle::OracleSource;
    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::state::State;
    use crate::state::user::{MarketType, OrderStatus, OrderType, SpotPosition, User, UserStats};
    use crate::test_utils::*;
    use crate::test_utils::{
        create_account_info, get_orders, get_positions, get_pyth_price, get_spot_positions,
    };
    use crate::{create_account_info, QUOTE_PRECISION_I64};

    use super::*;
    use crate::error::ErrorCode;
    use crate::state::fill_mode::FillMode;
    use crate::state::user_map::{UserMap, UserStatsMap};

    #[test]
    fn maker_order_canceled_for_breaching_oracle_price_band() {
        let clock = Clock {
            slot: 56,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                max_spread: 1000,
                base_spread: 0,
                long_spread: 0,
                short_spread: 0,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: oracle_price.twap as i64,
                    last_oracle_price_twap_5min: oracle_price.twap as i64,
                    last_oracle_price: oracle_price.agg.price as i64,
                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };
        market.status = MarketStatus::Active;
        market.amm.max_base_asset_reserve = u128::MAX;
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

        let mut user = User {
            authority: Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap(), // different authority than filler
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 50 * PRICE_PRECISION_I64,
                auction_duration: 5,
                price: 50 * PRICE_PRECISION_U64,
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
        create_anchor_account_info!(user, User, user_account_info);
        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, user_stats_account_info);
        let user_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&user_stats_account_info).unwrap();

        let maker_key = Pubkey::from_str("My11111111111111111111111111111111111111113").unwrap();
        let maker_authority =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let mut maker = User {
            authority: maker_authority,
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 50 * PRICE_PRECISION_U64,
                post_only: true,
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
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);
        let makers_and_referrers = UserMap::load_one(&maker_account_info).unwrap();

        let mut maker_stats = UserStats {
            authority: maker_authority,
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_and_referrer_stats = UserStatsMap::load_one(&maker_stats_account_info).unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        create_anchor_account_info!(User::default(), &filler_key, User, user_account_info);
        let filler_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, filler_stats_account_info);
        let filler_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&filler_stats_account_info).unwrap();

        let state = State {
            min_perp_auction_duration: 1,
            default_market_order_time_in_force: 10,
            ..State::default()
        };

        let base_asset_amount = fill_perp_order(
            1,
            &state,
            &user_account_loader,
            &user_stats_account_loader,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &filler_account_loader,
            &filler_stats_account_loader,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            None,
            &clock,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0);

        // order canceled
        let maker = makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        assert_eq!(maker.orders[0], Order::default());
    }

    #[test]
    fn fallback_maker_order_id() {
        let clock = Clock {
            slot: 56,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                max_spread: 1000,
                base_spread: 0,
                long_spread: 0,
                short_spread: 0,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: oracle_price.twap as i64,
                    last_oracle_price_twap_5min: oracle_price.twap as i64,
                    last_oracle_price: oracle_price.agg.price as i64,
                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };
        market.status = MarketStatus::Active;
        market.amm.max_base_asset_reserve = u128::MAX;
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

        let mut user = User {
            authority: Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap(), // different authority than filler
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                market_type: MarketType::Perp,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 5,
                price: 100 * PRICE_PRECISION_U64,
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
        create_anchor_account_info!(user, User, user_account_info);
        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, user_stats_account_info);
        let user_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&user_stats_account_info).unwrap();

        let maker_key = Pubkey::from_str("My11111111111111111111111111111111111111113").unwrap();
        let maker_authority =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let maker_order_id = 1;
        let mut maker = User {
            authority: maker_authority,
            orders: get_orders(Order {
                market_index: 0,
                order_id: maker_order_id,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                market_type: MarketType::Perp,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                post_only: true,
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
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);
        let makers_and_referrers = UserMap::load_one(&maker_account_info).unwrap();

        let mut maker_stats = UserStats {
            authority: maker_authority,
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_and_referrer_stats = UserStatsMap::load_one(&maker_stats_account_info).unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        create_anchor_account_info!(User::default(), &filler_key, User, user_account_info);
        let filler_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, filler_stats_account_info);
        let filler_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&filler_stats_account_info).unwrap();

        let state = State {
            min_perp_auction_duration: 1,
            default_market_order_time_in_force: 10,
            ..State::default()
        };

        let base_asset_amount = fill_perp_order(
            1,
            &state,
            &user_account_loader,
            &user_stats_account_loader,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &filler_account_loader,
            &filler_stats_account_loader,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            None,
            &clock,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 1000000000);
    }

    #[test]
    fn expire_order() {
        let mut market = PerpMarket {
            amm: AMM {
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                max_base_asset_reserve: 200 * AMM_RESERVE_PRECISION,
                min_base_asset_reserve: 50 * AMM_RESERVE_PRECISION,
                historical_oracle_data: HistoricalOracleData::default_price(PRICE_PRECISION_I64),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };

        market.status = MarketStatus::Active;

        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut oracle_map = get_oracle_map();

        let mut user = User {
            authority: Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap(),
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 102 * PRICE_PRECISION_I64,
                auction_duration: 5,
                price: 102 * PRICE_PRECISION_U64,
                max_ts: 10,
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
        create_anchor_account_info!(user, User, user_account_info);
        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, user_stats_account_info);
        let user_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&user_stats_account_info).unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        create_anchor_account_info!(User::default(), &filler_key, User, user_account_info);
        let filler_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, filler_stats_account_info);
        let filler_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&filler_stats_account_info).unwrap();

        let state = State {
            min_perp_auction_duration: 1,
            default_market_order_time_in_force: 10,
            ..State::default()
        };

        let clock = Clock {
            slot: 11,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 11,
        };

        let base_asset_amount = fill_perp_order(
            1,
            &state,
            &user_account_loader,
            &user_stats_account_loader,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &filler_account_loader,
            &filler_stats_account_loader,
            &UserMap::empty(),
            &UserStatsMap::empty(),
            None,
            &clock,
            FillMode::Fill,
        )
        .unwrap();

        let user_after = user_account_loader.load().unwrap();
        assert_eq!(base_asset_amount, 0);
        assert_eq!(user_after.perp_positions[0].open_orders, 0);
        assert_eq!(user_after.perp_positions[0].open_bids, 0);
        assert_eq!(user_after.perp_positions[0].quote_asset_amount, -10000);
        assert_eq!(user_after.orders[0], Order::default()); // order canceled

        let filler_after = filler_account_loader.load().unwrap();
        assert_eq!(filler_after.perp_positions[0].quote_asset_amount, 10000);
    }

    #[test]
    fn max_open_interest() {
        let clock = Clock {
            slot: 6,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                max_open_interest: 100,
                max_spread: 1000,
                base_spread: 0,
                long_spread: 0,
                short_spread: 0,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: oracle_price.twap as i64,
                    last_oracle_price_twap_5min: oracle_price.twap as i64,
                    last_oracle_price: oracle_price.agg.price as i64,
                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };
        market.status = MarketStatus::Active;
        market.amm.max_base_asset_reserve = u128::MAX;
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

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 102 * PRICE_PRECISION_I64,
                auction_duration: 5,
                price: 102 * PRICE_PRECISION_U64,
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
        create_anchor_account_info!(user, User, user_account_info);
        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, user_stats_account_info);
        let user_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&user_stats_account_info).unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        create_anchor_account_info!(User::default(), &filler_key, User, user_account_info);
        let filler_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, filler_stats_account_info);
        let filler_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&filler_stats_account_info).unwrap();

        let state = State {
            min_perp_auction_duration: 1,
            default_market_order_time_in_force: 10,
            ..State::default()
        };

        let err = fill_perp_order(
            1,
            &state,
            &user_account_loader,
            &user_stats_account_loader,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &filler_account_loader,
            &filler_stats_account_loader,
            &UserMap::empty(),
            &UserStatsMap::empty(),
            None,
            &clock,
            FillMode::Fill,
        );

        assert_eq!(err, Err(ErrorCode::MaxOpenInterest));
    }
}

#[cfg(test)]
pub mod fulfill_spot_order_with_match {
    use crate::controller::orders::fulfill_spot_order_with_match;
    use crate::controller::position::PositionDirection;
    use crate::math::constants::{
        LAMPORTS_PER_SOL_I64, LAMPORTS_PER_SOL_U64, PRICE_PRECISION_I64, PRICE_PRECISION_U64,
        QUOTE_PRECISION_U64, SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64,
    };
    use crate::math::spot_balance::calculate_utilization;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::user::{MarketType, Order, OrderType, SpotPosition, User, UserStats};
    use crate::test_utils::get_orders;
    use crate::SPOT_UTILIZATION_PRECISION;

    use super::*;

    #[test]
    fn long_taker_order_fulfilled_start_of_auction() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        let taker_quote_position = taker.spot_positions[0];
        assert_eq!(taker_quote_position.scaled_balance, 950000000);

        let taker_base_position = taker.spot_positions[1];
        assert_eq!(
            taker_base_position.scaled_balance,
            SPOT_BALANCE_PRECISION_U64
        );
        assert_eq!(taker_base_position.open_bids, 0);
        assert_eq!(taker_base_position.open_orders, 0);

        assert_eq!(taker_stats.taker_volume_30d, 100000000);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);

        let maker_quote_position = maker.spot_positions[0];
        assert_eq!(maker_quote_position.scaled_balance, 100030000000);

        let maker_base_position = maker.spot_positions[1];
        assert_eq!(maker_base_position.scaled_balance, 0);
        assert_eq!(maker_base_position.open_bids, 0);
        assert_eq!(maker_base_position.open_orders, 0);

        assert_eq!(maker_stats.maker_volume_30d, 100000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);

        assert_eq!(base_market.total_spot_fee, 20000);
        assert_eq!(base_market.spot_fee_pool.scaled_balance, 20000000);
    }

    #[test]
    fn long_taker_order_fulfilled_middle_of_auction() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 161 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 160 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 161 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 3_i64;
        let slot = 3_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        let taker_quote_position = taker.spot_positions[0];
        assert_eq!(taker_quote_position.scaled_balance, 920000000);

        let taker_base_position = taker.spot_positions[1];
        assert_eq!(
            taker_base_position.scaled_balance,
            SPOT_BALANCE_PRECISION_U64
        );
        assert_eq!(taker_base_position.open_bids, 0);
        assert_eq!(taker_base_position.open_orders, 0);

        assert_eq!(taker_stats.taker_volume_30d, 160000000);
        assert_eq!(taker_stats.fees.total_fee_paid, 80000);

        let maker_quote_position = maker.spot_positions[0];
        assert_eq!(maker_quote_position.scaled_balance, 160048000000);

        let maker_base_position = maker.spot_positions[1];
        assert_eq!(maker_base_position.scaled_balance, 0);
        assert_eq!(maker_base_position.open_bids, 0);
        assert_eq!(maker_base_position.open_orders, 0);

        assert_eq!(maker_stats.maker_volume_30d, 160000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 48000);

        assert_eq!(base_market.total_spot_fee, 32000);
        assert_eq!(base_market.spot_fee_pool.scaled_balance, 32000000);
    }

    #[test]
    fn short_taker_order_fulfilled_start_of_auction() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 50 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        let taker_quote_position = taker.spot_positions[0];
        assert_eq!(taker_quote_position.scaled_balance, 99950000000);

        let taker_base_position = taker.spot_positions[1];
        assert_eq!(taker_base_position.scaled_balance, 0);
        assert_eq!(taker_base_position.open_bids, 0);
        assert_eq!(taker_base_position.open_orders, 0);

        assert_eq!(taker_stats.taker_volume_30d, 100000000);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);

        let maker_quote_position = maker.spot_positions[0];
        assert_eq!(maker_quote_position.scaled_balance, 1030000000);

        let maker_base_position = maker.spot_positions[1];
        assert_eq!(
            maker_base_position.scaled_balance,
            SPOT_BALANCE_PRECISION_U64
        );
        assert_eq!(maker_base_position.open_bids, 0);
        assert_eq!(maker_base_position.open_orders, 0);

        assert_eq!(maker_stats.maker_volume_30d, 100000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);

        assert_eq!(base_market.total_spot_fee, 20000);
        assert_eq!(base_market.spot_fee_pool.scaled_balance, 20000000);
    }

    #[test]
    fn short_taker_order_fulfilled_middle_of_auction() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 50 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 70 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 3_i64;
        let slot = 3_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        let taker_quote_position = taker.spot_positions[0];
        assert_eq!(taker_quote_position.scaled_balance, 69965000000);

        let taker_base_position = taker.spot_positions[1];
        assert_eq!(taker_base_position.scaled_balance, 0);
        assert_eq!(taker_base_position.open_bids, 0);
        assert_eq!(taker_base_position.open_orders, 0);

        assert_eq!(taker_stats.taker_volume_30d, 70000000);
        assert_eq!(taker_stats.fees.total_fee_paid, 35000);

        let maker_quote_position = maker.spot_positions[0];
        assert_eq!(maker_quote_position.scaled_balance, 31021000000);

        let maker_base_position = maker.spot_positions[1];
        assert_eq!(
            maker_base_position.scaled_balance,
            SPOT_BALANCE_PRECISION_U64
        );
        assert_eq!(maker_base_position.open_bids, 0);
        assert_eq!(maker_base_position.open_orders, 0);

        assert_eq!(maker_stats.maker_volume_30d, 70000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 21000);

        assert_eq!(base_market.total_spot_fee, 14000);
        assert_eq!(base_market.spot_fee_pool.scaled_balance, 14000000);
    }

    #[test]
    fn long_taker_order_auction_price_does_not_satisfy_maker() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 201 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0)
    }

    #[test]
    fn short_taker_order_auction_price_does_not_satisfy_maker() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 50 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 49 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 3_i64;
        let slot = 3_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0);
    }

    #[test]
    fn maker_taker_same_direction() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 50 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 70 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 3_i64;
        let slot = 3_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0);
    }

    #[test]
    fn maker_taker_different_market_index() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 2,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0);
    }

    #[test]
    fn long_taker_order_bigger_than_maker() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: 100 * LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: 100 * LAMPORTS_PER_SOL_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_asset_amount, LAMPORTS_PER_SOL_U64);

        let taker_quote_position = taker.spot_positions[0];
        assert_eq!(taker_quote_position.scaled_balance, 950000000);

        let taker_base_position = taker.spot_positions[1];
        assert_eq!(
            taker_base_position.scaled_balance,
            SPOT_BALANCE_PRECISION_U64
        );
        assert_eq!(taker_base_position.open_bids, 99 * LAMPORTS_PER_SOL_I64);
        assert_eq!(taker_base_position.open_orders, 1);

        let taker_order = taker.orders[0];
        assert_eq!(taker_order.base_asset_amount_filled, LAMPORTS_PER_SOL_U64);
        assert_eq!(
            taker_order.quote_asset_amount_filled,
            100 * QUOTE_PRECISION_U64
        );

        assert_eq!(taker_stats.taker_volume_30d, 100000000);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);

        let maker_quote_position = maker.spot_positions[0];
        assert_eq!(maker_quote_position.scaled_balance, 100030000000);

        let maker_base_position = maker.spot_positions[1];
        assert_eq!(maker_base_position.scaled_balance, 0);
        assert_eq!(maker_base_position.open_asks, 0);
        assert_eq!(maker_base_position.open_orders, 0);

        let maker_order = maker.orders[0];
        assert_eq!(maker_order, Order::default());

        assert_eq!(maker_stats.maker_volume_30d, 100000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);

        assert_eq!(base_market.total_spot_fee, 20000);
        assert_eq!(base_market.spot_fee_pool.scaled_balance, 20000000);
    }

    #[test]
    fn long_taker_order_smaller_than_maker() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -100 * LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: 100 * LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_asset_amount, LAMPORTS_PER_SOL_U64);

        let taker_quote_position = taker.spot_positions[0];
        assert_eq!(taker_quote_position.scaled_balance, 950000000);

        let taker_base_position = taker.spot_positions[1];
        assert_eq!(
            taker_base_position.scaled_balance,
            SPOT_BALANCE_PRECISION_U64
        );
        assert_eq!(taker_base_position.open_bids, 0);
        assert_eq!(taker_base_position.open_orders, 0);

        let taker_order = taker.orders[0];
        assert_eq!(taker_order, Order::default());

        assert_eq!(taker_stats.taker_volume_30d, 100000000);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);

        let maker_quote_position = maker.spot_positions[0];
        assert_eq!(maker_quote_position.scaled_balance, 100030000000);

        let maker_base_position = maker.spot_positions[1];
        assert_eq!(maker_base_position.scaled_balance, 0);
        assert_eq!(maker_base_position.open_asks, -99 * LAMPORTS_PER_SOL_I64);
        assert_eq!(maker_base_position.open_orders, 1);

        let maker_order = maker.orders[0];
        assert_eq!(maker_order.base_asset_amount_filled, LAMPORTS_PER_SOL_U64);
        assert_eq!(
            maker_order.quote_asset_amount_filled,
            100 * QUOTE_PRECISION_U64
        );

        assert_eq!(maker_stats.maker_volume_30d, 100000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);

        assert_eq!(base_market.total_spot_fee, 20000);
        assert_eq!(base_market.spot_fee_pool.scaled_balance, 20000000);
    }

    #[test]
    fn double_dutch_auction() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                auction_start_price: 200 * PRICE_PRECISION_I64,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 5,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 5_i64;
        let slot = 5_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        let taker_quote_position = taker.spot_positions[0];
        assert_eq!(taker_quote_position.scaled_balance, 950000000);

        let taker_base_position = taker.spot_positions[1];
        assert_eq!(
            taker_base_position.scaled_balance,
            SPOT_BALANCE_PRECISION_U64
        );
        assert_eq!(taker_base_position.open_bids, 0);
        assert_eq!(taker_base_position.open_orders, 0);

        assert_eq!(taker_stats.taker_volume_30d, 100000000);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);

        let maker_quote_position = maker.spot_positions[0];
        assert_eq!(maker_quote_position.scaled_balance, 100030000000);

        let maker_base_position = maker.spot_positions[1];
        assert_eq!(maker_base_position.scaled_balance, 0);
        assert_eq!(maker_base_position.open_bids, 0);
        assert_eq!(maker_base_position.open_orders, 0);

        assert_eq!(maker_stats.maker_volume_30d, 100000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);

        assert_eq!(base_market.total_spot_fee, 20000);
        assert_eq!(base_market.spot_fee_pool.scaled_balance, 20000000);
    }

    #[test]
    fn taker_bid_crosses_maker_ask() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        let taker_quote_position = taker.spot_positions[0];
        assert_eq!(taker_quote_position.scaled_balance, 950000000);

        let taker_base_position = taker.spot_positions[1];
        assert_eq!(
            taker_base_position.scaled_balance,
            SPOT_BALANCE_PRECISION_U64
        );
        assert_eq!(taker_base_position.open_bids, 0);
        assert_eq!(taker_base_position.open_orders, 0);

        assert_eq!(taker_stats.taker_volume_30d, 100000000);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);

        let maker_quote_position = maker.spot_positions[0];
        assert_eq!(maker_quote_position.scaled_balance, 100030000000);

        let maker_base_position = maker.spot_positions[1];
        assert_eq!(maker_base_position.scaled_balance, 0);
        assert_eq!(maker_base_position.open_bids, 0);
        assert_eq!(maker_base_position.open_orders, 0);

        assert_eq!(maker_stats.maker_volume_30d, 100000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);

        assert_eq!(base_market.total_spot_fee, 20000);
        assert_eq!(base_market.spot_fee_pool.scaled_balance, 20000000);
    }

    #[test]
    fn taker_ask_crosses_maker_bid() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        let taker_quote_position = taker.spot_positions[0];
        assert_eq!(taker_quote_position.scaled_balance, 99950000000);

        let taker_base_position = taker.spot_positions[1];
        assert_eq!(taker_base_position.scaled_balance, 0);
        assert_eq!(taker_base_position.open_bids, 0);
        assert_eq!(taker_base_position.open_orders, 0);

        assert_eq!(taker_stats.taker_volume_30d, 100000000);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);

        let maker_quote_position = maker.spot_positions[0];
        assert_eq!(maker_quote_position.scaled_balance, 1030000000);

        let maker_base_position = maker.spot_positions[1];
        assert_eq!(
            maker_base_position.scaled_balance,
            SPOT_BALANCE_PRECISION_U64
        );
        assert_eq!(maker_base_position.open_bids, 0);
        assert_eq!(maker_base_position.open_orders, 0);

        assert_eq!(maker_stats.maker_volume_30d, 100000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);

        assert_eq!(base_market.total_spot_fee, 20000);
        assert_eq!(base_market.spot_fee_pool.scaled_balance, 20000000);
    }

    #[test]
    fn zero_price_market_order_cant_match() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                price: 0,
                auction_duration: 0,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0);
    }

    #[test]
    fn taker_short_selling_base_no_borrow_liquidity() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 0,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: 0,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_filled, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_filled, 0);
    }

    #[test]
    fn taker_short_selling_base_small_borrow_liquidity() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 0,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            deposit_token_twap: SPOT_BALANCE_PRECISION as u64,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            deposit_token_twap: 101 * QUOTE_PRECISION_U64,

            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_filled, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_filled, 166666666);
    }

    #[test]
    fn maker_short_selling_quote_no_borrow_liquidity() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 0,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 0,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_filled, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_filled, 0);
    }

    #[test]
    fn maker_short_selling_quote_little_borrow_liquidity() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 0,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            deposit_token_twap: SPOT_BALANCE_PRECISION as u64,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 100 * SPOT_BALANCE_PRECISION,
            deposit_token_twap: 100 * QUOTE_PRECISION_U64,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_filled, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_filled, 166666660);
    }

    #[test]
    fn taker_short_selling_quote_no_borrow_liquidity() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 0,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            deposit_token_twap: SPOT_BALANCE_PRECISION as u64,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 0,
            deposit_token_twap: 0,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_filled, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_filled, 0);
    }

    #[test]
    fn taker_short_selling_quote_little_borrow_liquidity() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 0,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            deposit_token_twap: SPOT_BALANCE_PRECISION as u64,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 100 * SPOT_BALANCE_PRECISION,
            deposit_token_twap: 100 * QUOTE_PRECISION_U64,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_filled, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_filled, 166666660);
    }

    #[test]
    fn maker_short_selling_base_no_borrow_liquidity() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 0,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: 0,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_filled, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_filled, 0);
    }

    #[test]
    fn maker_short_selling_base_little_borrow_liquidity() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 0,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            deposit_token_twap: SPOT_BALANCE_PRECISION as u64,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            deposit_token_twap: 101 * QUOTE_PRECISION_U64,
            ..SpotMarket::default_quote_market()
        };

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_filled, _) = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        assert_eq!(base_filled, 166666666);
    }

    #[test]
    fn max_utilization() {
        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            utilization_twap: SPOT_UTILIZATION_PRECISION as u64,
            ..SpotMarket::default_base_market()
        };
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            borrow_balance: 101 * SPOT_BALANCE_PRECISION,
            utilization_twap: SPOT_UTILIZATION_PRECISION as u64,
            ..SpotMarket::default_quote_market()
        };

        let base_utilization = calculate_utilization(
            base_market.get_deposits().unwrap(),
            base_market.get_borrows().unwrap(),
        )
        .unwrap();

        assert_eq!(base_utilization, SPOT_UTILIZATION_PRECISION);

        let quote_utilization = calculate_utilization(
            base_market.get_deposits().unwrap(),
            base_market.get_borrows().unwrap(),
        )
        .unwrap();

        assert_eq!(quote_utilization, SPOT_UTILIZATION_PRECISION);

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut Some(&mut maker_stats),
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
        )
        .unwrap();

        let taker_quote_position = taker.spot_positions[0];
        assert_eq!(taker_quote_position.scaled_balance, 950000000);

        let taker_base_position = taker.spot_positions[1];
        assert_eq!(
            taker_base_position.scaled_balance,
            SPOT_BALANCE_PRECISION_U64
        );
        assert_eq!(taker_base_position.open_bids, 0);
        assert_eq!(taker_base_position.open_orders, 0);

        let base_utilization = calculate_utilization(
            base_market.get_deposits().unwrap(),
            base_market.get_borrows().unwrap(),
        )
        .unwrap();

        assert_eq!(base_utilization, SPOT_UTILIZATION_PRECISION);

        let quote_utilization = calculate_utilization(
            base_market.get_deposits().unwrap(),
            base_market.get_borrows().unwrap(),
        )
        .unwrap();

        assert_eq!(quote_utilization, SPOT_UTILIZATION_PRECISION);
    }
}

pub mod fulfill_spot_order {
    use std::str::FromStr;

    use anchor_lang::prelude::{AccountLoader, Clock};

    use crate::controller::orders::fill_spot_order;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::error::ErrorCode;
    use crate::math::constants::{
        LAMPORTS_PER_SOL_I64, LAMPORTS_PER_SOL_U64, PRICE_PRECISION_I64, PRICE_PRECISION_U64,
        SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64,
    };
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_fulfillment_params::TestFulfillmentParams;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::state::State;
    use crate::state::user::{MarketType, OrderStatus, OrderType, SpotPosition, User, UserStats};
    use crate::test_utils::get_pyth_price;
    use crate::test_utils::*;

    use super::*;

    // Add back if we check free collateral in fill again
    // #[test]
    // fn fulfill_with_negative_free_collateral() {
    //     let clock = Clock {
    //         slot: 6,
    //         epoch_start_timestamp: 0,
    //         epoch: 0,
    //         leader_schedule_epoch: 0,
    //         unix_timestamp: 0,
    //     };
    //
    //     let mut oracle_price = get_pyth_price(100, 6);
    //     let oracle_price_key =
    //         Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    //     let pyth_program = crate::ids::pyth_program::id();
    //     create_account_info!(
    //         oracle_price,
    //         &oracle_price_key,
    //         &pyth_program,
    //         oracle_account_info
    //     );
    //     let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();
    //
    //     let perp_market_map = PerpMarketMap::empty();
    //
    //     let mut base_market = SpotMarket {
    //         oracle: oracle_price_key,
    //         market_index: 1,
    //         deposit_balance: SPOT_BALANCE_PRECISION,
    //         ..SpotMarket::default_base_market()
    //     };
    //     create_anchor_account_info!(base_market, SpotMarket, base_market_account_info);
    //     let mut quote_market = SpotMarket {
    //         deposit_balance: 101 * SPOT_BALANCE_PRECISION,
    //         ..SpotMarket::default_quote_market()
    //     };
    //     create_anchor_account_info!(quote_market, SpotMarket, quote_market_account_info);
    //     let spot_market_map = SpotMarketMap::load_multiple(
    //         vec![&base_market_account_info, &quote_market_account_info],
    //         true,
    //     )
    //     .unwrap();
    //
    //     let mut taker_spot_positions = [SpotPosition::default(); 8];
    //     taker_spot_positions[0] = SpotPosition {
    //         market_index: 0,
    //         scaled_balance: SPOT_BALANCE_PRECISION_U64,
    //         balance_type: SpotBalanceType::Deposit,
    //         ..SpotPosition::default()
    //     };
    //     taker_spot_positions[1] = SpotPosition {
    //         market_index: 1,
    //         open_orders: 1,
    //         open_bids: LAMPORTS_PER_SOL_I64,
    //         ..SpotPosition::default()
    //     };
    //     let mut taker = User {
    //         orders: get_orders(Order {
    //             order_id: 1,
    //             market_index: 1,
    //             market_type: MarketType::Spot,
    //             order_type: OrderType::Market,
    //             status: OrderStatus::Open,
    //             direction: PositionDirection::Long,
    //             base_asset_amount: LAMPORTS_PER_SOL_U64,
    //             slot: 0,
    //             auction_start_price: 100 * PRICE_PRECISION_U64,
    //             auction_end_price: 200 * PRICE_PRECISION_U64,
    //             auction_duration: 5,
    //             price: 100 * PRICE_PRECISION_U64,
    //             ..Order::default()
    //         }),
    //         spot_positions: taker_spot_positions,
    //         ..User::default()
    //     };
    //
    //     create_anchor_account_info!(taker, User, taker_account_info);
    //     let taker_account_loader: AccountLoader<User> =
    //         AccountLoader::try_from(&taker_account_info).unwrap();
    //
    //     create_anchor_account_info!(UserStats::default(), UserStats, taker_stats_account_info);
    //     let taker_stats_account_loader: AccountLoader<UserStats> =
    //         AccountLoader::try_from(&taker_stats_account_info).unwrap();
    //
    //     let mut maker_spot_positions = [SpotPosition::default(); 8];
    //     maker_spot_positions[1] = SpotPosition {
    //         market_index: 1,
    //         balance_type: SpotBalanceType::Deposit,
    //         scaled_balance: SPOT_BALANCE_PRECISION_U64,
    //         open_orders: 1,
    //         open_asks: -LAMPORTS_PER_SOL_I64 / 2,
    //         ..SpotPosition::default()
    //     };
    //     let mut maker = User {
    //         orders: get_orders(Order {
    //             order_id: 1,
    //             market_index: 1,
    //             post_only: true,
    //             market_type: MarketType::Spot,
    //             order_type: OrderType::Limit,
    //             status: OrderStatus::Open,
    //             direction: PositionDirection::Short,
    //             base_asset_amount: LAMPORTS_PER_SOL_U64 / 2,
    //             price: 100 * PRICE_PRECISION_U64,
    //             ..Order::default()
    //         }),
    //         spot_positions: maker_spot_positions,
    //         ..User::default()
    //     };
    //
    //     let maker_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
    //     create_anchor_account_info!(maker, &maker_key, User, maker_account_info);
    //     let maker_account_loader: AccountLoader<User> =
    //         AccountLoader::try_from(&maker_account_info).unwrap();
    //
    //     create_anchor_account_info!(UserStats::default(), UserStats, maker_stats_account_info);
    //     let maker_stats_account_loader: AccountLoader<UserStats> =
    //         AccountLoader::try_from(&maker_stats_account_info).unwrap();
    //
    //     let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
    //     create_anchor_account_info!(User::default(), &filler_key, User, user_account_info);
    //     let filler_account_loader: AccountLoader<User> =
    //         AccountLoader::try_from(&user_account_info).unwrap();
    //
    //     create_anchor_account_info!(UserStats::default(), UserStats, filler_stats_account_info);
    //     let filler_stats_account_loader: AccountLoader<UserStats> =
    //         AccountLoader::try_from(&filler_stats_account_info).unwrap();
    //
    //     let state = State {
    //         default_spot_auction_duration: 1,
    //         ..State::default()
    //     };
    //
    //     let free_collateral =
    //         calculate_free_collateral(&taker, &perp_market_map, &spot_market_map, &mut oracle_map)
    //             .unwrap();
    //     assert_eq!(free_collateral, -19000000);
    //
    //     let base_asset_amount = fill_spot_order(
    //         1,
    //         &state,
    //         &taker_account_loader,
    //         &taker_stats_account_loader,
    //         &spot_market_map,
    //         &perp_market_map,
    //         &mut oracle_map,
    //         &filler_account_loader,
    //         &filler_stats_account_loader,
    //         Some(&maker_account_loader),
    //         Some(&maker_stats_account_loader),
    //         Some(1),
    //         &clock,
    //         &mut None,
    //     )
    //     .unwrap();
    //
    //     assert_eq!(base_asset_amount, 0); // cancel should be canceled
    //     let taker_after = taker_account_loader.load().unwrap();
    //     assert_eq!(taker_after.orders[0], Order::default()); // order canceled
    //
    //     let free_collateral = calculate_free_collateral(
    //         &taker_after,
    //         &perp_market_map,
    //         &spot_market_map,
    //         &mut oracle_map,
    //     )
    //     .unwrap();
    //     assert_eq!(free_collateral, 1000000);
    //
    //     let maker_after = maker_account_loader.load().unwrap();
    //     assert_eq!(*maker_after, maker); // maker should not have changed
    // }

    #[test]
    fn fulfill_users_with_multiple_orders_and_markets() {
        let clock = Clock {
            slot: 6,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let perp_market_map = PerpMarketMap::empty();

        let mut base_market = SpotMarket {
            market_index: 1,
            deposit_balance: SPOT_BALANCE_PRECISION,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData::default_price(100 * PRICE_PRECISION_I64),
            ..SpotMarket::default_base_market()
        };
        create_anchor_account_info!(base_market, SpotMarket, base_market_account_info);
        let mut second_base_market = SpotMarket {
            market_index: 2,
            deposit_balance: SPOT_BALANCE_PRECISION,
            historical_oracle_data: HistoricalOracleData::default_price(100 * PRICE_PRECISION_I64),
            ..SpotMarket::default_base_market()
        };
        create_anchor_account_info!(
            second_base_market,
            SpotMarket,
            second_base_market_account_info
        );
        let mut quote_market = SpotMarket {
            market_index: 0,
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };
        create_anchor_account_info!(quote_market, SpotMarket, quote_market_account_info);
        let spot_market_map = SpotMarketMap::load_multiple(
            vec![
                &base_market_account_info,
                &quote_market_account_info,
                &second_base_market_account_info,
            ],
            true,
        )
        .unwrap();

        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        taker_spot_positions[2] = SpotPosition {
            market_index: 2,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker_orders = [Order::default(); 32];
        taker_orders[0] = Order {
            order_id: 1,
            market_index: 1,
            market_type: MarketType::Spot,
            order_type: OrderType::Market,
            status: OrderStatus::Open,
            direction: PositionDirection::Long,
            base_asset_amount: LAMPORTS_PER_SOL_U64,
            slot: 0,
            auction_start_price: 100 * PRICE_PRECISION_I64,
            auction_end_price: 200 * PRICE_PRECISION_I64,
            auction_duration: 5,
            price: 100 * PRICE_PRECISION_U64,
            ..Order::default()
        };
        taker_orders[1] = Order {
            order_id: 2,
            market_index: 2,
            market_type: MarketType::Spot,
            order_type: OrderType::Market,
            status: OrderStatus::Open,
            direction: PositionDirection::Long,
            base_asset_amount: LAMPORTS_PER_SOL_U64,
            slot: 0,
            auction_start_price: 100 * PRICE_PRECISION_I64,
            auction_end_price: 200 * PRICE_PRECISION_I64,
            auction_duration: 5,
            price: 100 * PRICE_PRECISION_U64,
            ..Order::default()
        };
        let mut taker = User {
            orders: taker_orders,
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        create_anchor_account_info!(taker, User, taker_account_info);
        let taker_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&taker_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, taker_stats_account_info);
        let taker_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&taker_stats_account_info).unwrap();

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 2,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64 / 2,
            ..SpotPosition::default()
        };
        maker_spot_positions[2] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker_orders = [Order::default(); 32];
        maker_orders[0] = Order {
            order_id: 2,
            market_index: 2,
            post_only: true,
            market_type: MarketType::Spot,
            order_type: OrderType::Limit,
            status: OrderStatus::Open,
            direction: PositionDirection::Short,
            base_asset_amount: LAMPORTS_PER_SOL_U64,
            price: 100 * PRICE_PRECISION_U64,
            ..Order::default()
        };
        maker_orders[1] = Order {
            order_id: 1,
            market_index: 1,
            post_only: true,
            market_type: MarketType::Spot,
            order_type: OrderType::Limit,
            status: OrderStatus::Open,
            direction: PositionDirection::Short,
            base_asset_amount: LAMPORTS_PER_SOL_U64,
            price: 100 * PRICE_PRECISION_U64,
            ..Order::default()
        };
        let mut maker = User {
            orders: maker_orders,
            spot_positions: maker_spot_positions,
            authority: Pubkey::from_str("My11111111111111111111111111111111111111112").unwrap(),
            ..User::default()
        };

        let maker_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);
        let maker_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&maker_account_info).unwrap();

        let mut maker_stats = UserStats {
            authority: Pubkey::from_str("My11111111111111111111111111111111111111112").unwrap(),
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&maker_stats_account_info).unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        create_anchor_account_info!(User::default(), &filler_key, User, user_account_info);
        let filler_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, filler_stats_account_info);
        let filler_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&filler_stats_account_info).unwrap();

        let state = State {
            default_spot_auction_duration: 1,
            ..State::default()
        };

        let mut expected_taker = taker;
        expected_taker.orders[0] = Order::default();
        expected_taker.spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 900000000,
            cumulative_deposits: -100000000,
            ..SpotPosition::default()
        };
        expected_taker.spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            cumulative_deposits: 1000000000,
            ..SpotPosition::default()
        };
        expected_taker.cumulative_spot_fees = -100000;
        expected_taker.last_active_slot = clock.slot;

        let mut expected_maker = maker;
        expected_maker.orders[1] = Order::default();
        expected_maker.spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100020000000,
            cumulative_deposits: 100000000,
            ..SpotPosition::default()
        };
        expected_maker.spot_positions[2] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 0,
            cumulative_deposits: -1000000000,
            ..SpotPosition::default()
        };
        expected_maker.cumulative_spot_fees = 20000;
        expected_maker.last_active_slot = clock.slot;

        let base_asset_amount = fill_spot_order(
            1,
            &state,
            &taker_account_loader,
            &taker_stats_account_loader,
            &spot_market_map,
            &perp_market_map,
            &mut oracle_map,
            &filler_account_loader,
            &filler_stats_account_loader,
            Some(&maker_account_loader),
            Some(&maker_stats_account_loader),
            Some(1),
            &clock,
            &mut TestFulfillmentParams {},
        )
        .unwrap();

        assert_eq!(base_asset_amount, 1000000000); // full order filled by maker
        let taker_after = taker_account_loader.load().unwrap();
        assert_eq!(*taker_after, expected_taker);

        let taker_stats_after = taker_stats_account_loader.load().unwrap();
        assert_eq!(taker_stats_after.fees.total_fee_paid, 100000);

        let maker_after = maker_account_loader.load().unwrap();
        assert_eq!(*maker_after, expected_maker);

        let maker_stats_after = maker_stats_account_loader.load().unwrap();
        assert_eq!(maker_stats_after.fees.total_fee_rebate, 20000);
    }

    #[test]
    fn maker_insufficient_collateral() {
        let clock = Clock {
            slot: 6,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let perp_market_map = PerpMarketMap::empty();

        let mut base_market = SpotMarket {
            market_index: 1,
            deposit_balance: SPOT_BALANCE_PRECISION,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData::default_price(100 * PRICE_PRECISION_I64),
            ..SpotMarket::default_base_market()
        };
        create_anchor_account_info!(base_market, SpotMarket, base_market_account_info);
        let mut quote_market = SpotMarket {
            market_index: 0,
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };
        create_anchor_account_info!(quote_market, SpotMarket, quote_market_account_info);
        let spot_market_map = SpotMarketMap::load_multiple(
            vec![&base_market_account_info, &quote_market_account_info],
            true,
        )
        .unwrap();

        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker_orders = [Order::default(); 32];
        taker_orders[0] = Order {
            order_id: 1,
            market_index: 1,
            market_type: MarketType::Spot,
            order_type: OrderType::Market,
            status: OrderStatus::Open,
            direction: PositionDirection::Long,
            base_asset_amount: LAMPORTS_PER_SOL_U64,
            slot: 0,
            auction_start_price: 100 * PRICE_PRECISION_I64,
            auction_end_price: 200 * PRICE_PRECISION_I64,
            auction_duration: 5,
            price: 100 * PRICE_PRECISION_U64,
            ..Order::default()
        };
        let mut taker = User {
            orders: taker_orders,
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        create_anchor_account_info!(taker, User, taker_account_info);
        let taker_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&taker_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, taker_stats_account_info);
        let taker_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&taker_stats_account_info).unwrap();

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[2] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64 / 10,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut maker_orders = [Order::default(); 32];
        maker_orders[1] = Order {
            order_id: 1,
            market_index: 1,
            post_only: true,
            market_type: MarketType::Spot,
            order_type: OrderType::Limit,
            status: OrderStatus::Open,
            direction: PositionDirection::Short,
            base_asset_amount: LAMPORTS_PER_SOL_U64,
            price: 100 * PRICE_PRECISION_U64,
            ..Order::default()
        };
        let mut maker = User {
            orders: maker_orders,
            spot_positions: maker_spot_positions,
            authority: Pubkey::from_str("My11111111111111111111111111111111111111112").unwrap(),
            ..User::default()
        };

        let maker_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);
        let maker_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&maker_account_info).unwrap();

        let mut maker_stats = UserStats {
            authority: Pubkey::from_str("My11111111111111111111111111111111111111112").unwrap(),
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&maker_stats_account_info).unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        create_anchor_account_info!(User::default(), &filler_key, User, user_account_info);
        let filler_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, filler_stats_account_info);
        let filler_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&filler_stats_account_info).unwrap();

        let state = State {
            default_spot_auction_duration: 1,
            ..State::default()
        };

        let result = fill_spot_order(
            1,
            &state,
            &taker_account_loader,
            &taker_stats_account_loader,
            &spot_market_map,
            &perp_market_map,
            &mut oracle_map,
            &filler_account_loader,
            &filler_stats_account_loader,
            Some(&maker_account_loader),
            Some(&maker_stats_account_loader),
            Some(1),
            &clock,
            &mut TestFulfillmentParams {},
        );

        assert_eq!(result, Err(ErrorCode::InsufficientCollateral));
    }
}

pub mod fill_spot_order {
    use std::str::FromStr;

    use anchor_lang::prelude::{AccountLoader, Clock};

    use crate::controller::orders::fill_spot_order;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        LAMPORTS_PER_SOL_I64, LAMPORTS_PER_SOL_U64, PRICE_PRECISION_I64, PRICE_PRECISION_U64,
        SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64,
    };
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_fulfillment_params::TestFulfillmentParams;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::state::State;
    use crate::state::user::{MarketType, OrderStatus, OrderType, SpotPosition, User, UserStats};
    use crate::test_utils::*;
    use crate::test_utils::{create_account_info, get_orders, get_pyth_price};

    use super::*;

    #[test]
    fn expire_order() {
        let clock = Clock {
            slot: 11,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 11,
        };

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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let perp_market_map = PerpMarketMap::empty();

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
            historical_oracle_data: HistoricalOracleData::default_price(PRICE_PRECISION_I64),
            ..SpotMarket::default_base_market()
        };
        create_anchor_account_info!(base_market, SpotMarket, base_market_account_info);
        let mut quote_market = SpotMarket {
            deposit_balance: 101 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default_quote_market()
        };
        create_anchor_account_info!(quote_market, SpotMarket, quote_market_account_info);
        let spot_market_map = SpotMarketMap::load_multiple(
            vec![&base_market_account_info, &quote_market_account_info],
            true,
        )
        .unwrap();

        let mut taker_spot_positions = [SpotPosition::default(); 8];
        taker_spot_positions[0] = SpotPosition {
            market_index: 0,
            scaled_balance: 101 * SPOT_BALANCE_PRECISION_U64,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        taker_spot_positions[1] = SpotPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: LAMPORTS_PER_SOL_I64,
            ..SpotPosition::default()
        };
        let mut taker = User {
            orders: get_orders(Order {
                order_id: 1,
                market_index: 1,
                market_type: MarketType::Spot,
                order_type: OrderType::Market,
                status: OrderStatus::Open,
                direction: PositionDirection::Long,
                base_asset_amount: LAMPORTS_PER_SOL_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 5,
                price: 100 * PRICE_PRECISION_U64,
                max_ts: 10,
                ..Order::default()
            }),
            spot_positions: taker_spot_positions,
            ..User::default()
        };

        create_anchor_account_info!(taker, User, taker_account_info);
        let taker_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&taker_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, taker_stats_account_info);
        let taker_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&taker_stats_account_info).unwrap();

        let mut maker_spot_positions = [SpotPosition::default(); 8];
        maker_spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -LAMPORTS_PER_SOL_I64 / 2,
            ..SpotPosition::default()
        };
        let mut maker = User {
            orders: get_orders(Order {
                order_id: 1,
                market_index: 1,
                post_only: true,
                market_type: MarketType::Spot,
                order_type: OrderType::Limit,
                status: OrderStatus::Open,
                direction: PositionDirection::Short,
                base_asset_amount: LAMPORTS_PER_SOL_U64 / 2,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            spot_positions: maker_spot_positions,
            ..User::default()
        };

        let maker_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);
        let maker_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&maker_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, maker_stats_account_info);
        let maker_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&maker_stats_account_info).unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        create_anchor_account_info!(User::default(), &filler_key, User, user_account_info);
        let filler_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, filler_stats_account_info);
        let filler_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&filler_stats_account_info).unwrap();

        let state = State {
            default_spot_auction_duration: 1,
            ..State::default()
        };

        let base_asset_amount = fill_spot_order(
            1,
            &state,
            &taker_account_loader,
            &taker_stats_account_loader,
            &spot_market_map,
            &perp_market_map,
            &mut oracle_map,
            &filler_account_loader,
            &filler_stats_account_loader,
            Some(&maker_account_loader),
            Some(&maker_stats_account_loader),
            Some(1),
            &clock,
            &mut TestFulfillmentParams {},
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0); // half of order filled by maker
        let taker_after = taker_account_loader.load().unwrap();
        assert_eq!(taker_after.orders[0], Order::default()); // order expired
    }
}

pub mod force_cancel_orders {
    use std::str::FromStr;

    use anchor_lang::prelude::{AccountLoader, Clock};

    use crate::controller::orders::force_cancel_orders;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I64, BASE_PRECISION_U64, LAMPORTS_PER_SOL_I64,
        LAMPORTS_PER_SOL_U64, PEG_PRECISION, PRICE_PRECISION_U64, SPOT_BALANCE_PRECISION,
        SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::oracle::OracleSource;
    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::state::State;
    use crate::state::user::{MarketType, OrderStatus, OrderType, SpotPosition, User, UserStats};
    use crate::test_utils::*;
    use crate::test_utils::{
        create_account_info, get_positions, get_pyth_price, get_spot_positions,
    };

    use super::*;

    #[test]
    fn cancel_order_after_fulfill() {
        let clock = Clock {
            slot: 6,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                // bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                // bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                // ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                // ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                max_spread: 1000,
                base_spread: 0,
                long_spread: 0,
                short_spread: 0,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: oracle_price.twap as i64,
                    last_oracle_price_twap_5min: oracle_price.twap as i64,
                    last_oracle_price: oracle_price.agg.price as i64,
                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };
        market.status = MarketStatus::Active;
        market.amm.max_base_asset_reserve = u128::MAX;
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

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            deposit_balance: SPOT_BALANCE_PRECISION,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);

        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            deposit_balance: SPOT_BALANCE_PRECISION,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            oracle: oracle_price_key,
            ..SpotMarket::default_base_market()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);

        let spot_market_map = SpotMarketMap::load_multiple(
            vec![
                &usdc_spot_market_account_info,
                &sol_spot_market_account_info,
            ],
            true,
        )
        .unwrap();

        let mut orders = [Order::default(); 32];
        orders[0] = Order {
            market_index: 0,
            order_id: 1,
            status: OrderStatus::Open,
            order_type: OrderType::Limit,
            market_type: MarketType::Perp,
            direction: PositionDirection::Long,
            base_asset_amount: 100 * BASE_PRECISION_U64,
            slot: 0,
            price: 102 * PRICE_PRECISION_U64,
            ..Order::default()
        };
        orders[1] = Order {
            market_index: 0,
            order_id: 2,
            status: OrderStatus::Open,
            order_type: OrderType::Limit,
            market_type: MarketType::Perp,
            direction: PositionDirection::Short,
            base_asset_amount: BASE_PRECISION_U64,
            slot: 0,
            price: 102 * PRICE_PRECISION_U64,
            ..Order::default()
        };
        orders[2] = Order {
            market_index: 1,
            order_id: 1,
            status: OrderStatus::Open,
            order_type: OrderType::Limit,
            market_type: MarketType::Spot,
            direction: PositionDirection::Long,
            base_asset_amount: 100 * LAMPORTS_PER_SOL_U64,
            slot: 0,
            price: 102 * PRICE_PRECISION_U64,
            ..Order::default()
        };
        orders[3] = Order {
            market_index: 1,
            order_id: 1,
            status: OrderStatus::Open,
            order_type: OrderType::Limit,
            market_type: MarketType::Spot,
            direction: PositionDirection::Short,
            base_asset_amount: LAMPORTS_PER_SOL_U64,
            slot: 0,
            price: 102 * PRICE_PRECISION_U64,
            ..Order::default()
        };

        let mut user = User {
            authority: Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap(), // different authority than filler
            orders,
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64,
                open_orders: 2,
                open_bids: 100 * BASE_PRECISION_I64,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 1,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: SPOT_BALANCE_PRECISION_U64,
                open_orders: 2,
                open_bids: 100 * LAMPORTS_PER_SOL_I64,
                open_asks: -LAMPORTS_PER_SOL_I64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };
        create_anchor_account_info!(user, User, user_account_info);
        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, user_stats_account_info);
        let _user_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&user_stats_account_info).unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        create_anchor_account_info!(User::default(), &filler_key, User, user_account_info);
        let filler_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        create_anchor_account_info!(UserStats::default(), UserStats, filler_stats_account_info);
        let _filler_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&filler_stats_account_info).unwrap();

        let state = State {
            min_perp_auction_duration: 1,
            default_market_order_time_in_force: 10,
            ..State::default()
        };

        force_cancel_orders(
            &state,
            &user_account_loader,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &filler_account_loader,
            &clock,
        )
        .unwrap();

        let user = user_account_loader.load().unwrap();
        assert_eq!(user.orders[0], Order::default());
        assert_ne!(user.orders[1], Order::default());
        assert_eq!(user.orders[2], Order::default());
        assert_ne!(user.orders[3], Order::default());

        assert_eq!(user.spot_positions[0].scaled_balance, 20000001);
        assert_eq!(user.spot_positions[0].balance_type, SpotBalanceType::Borrow,);
    }
}

pub mod insert_maker_order_info {
    use crate::controller::orders::insert_maker_order_info;
    use crate::controller::position::PositionDirection;
    use solana_program::pubkey::Pubkey;

    #[test]
    fn bids() {
        let mut bids = Vec::with_capacity(3);
        bids.push((Pubkey::default(), 1, 10));
        bids.push((Pubkey::default(), 0, 1));
        let maker_direction = PositionDirection::Long;

        insert_maker_order_info(&mut bids, (Pubkey::default(), 2, 100), maker_direction);

        assert_eq!(
            bids,
            vec![
                (Pubkey::default(), 2, 100),
                (Pubkey::default(), 1, 10),
                (Pubkey::default(), 0, 1),
            ]
        );
    }

    #[test]
    fn asks() {
        let mut asks = Vec::with_capacity(3);
        asks.push((Pubkey::default(), 0, 1));
        asks.push((Pubkey::default(), 1, 10));
        let maker_direction = PositionDirection::Short;

        insert_maker_order_info(&mut asks, (Pubkey::default(), 2, 100), maker_direction);

        assert_eq!(
            asks,
            vec![
                (Pubkey::default(), 0, 1),
                (Pubkey::default(), 1, 10),
                (Pubkey::default(), 2, 100)
            ]
        );
    }
}

pub mod get_maker_orders_info {
    use std::str::FromStr;

    use anchor_lang::prelude::{AccountLoader, Clock};

    use crate::controller::orders::get_maker_orders_info;
    use crate::controller::position::PositionDirection;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I64, BASE_PRECISION_U64, PEG_PRECISION,
        PRICE_PRECISION_I64, PRICE_PRECISION_U64, SPOT_BALANCE_PRECISION_U64,
        SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::oracle::OracleSource;
    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{OrderStatus, OrderType, SpotPosition, User};
    use crate::state::user_map::UserMap;
    use crate::test_utils::*;
    use crate::test_utils::{
        create_account_info, get_orders, get_positions, get_pyth_price, get_spot_positions,
    };
    use crate::{create_account_info, get_orders};
    use crate::{create_anchor_account_info, QUOTE_PRECISION_I64};

    use super::*;

    #[test]
    fn one_maker_order_canceled_for_breaching_oracle_price_band() {
        let clock = Clock {
            slot: 56,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

        let mut pyth_price = get_pyth_price(100, 6);
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            pyth_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                max_spread: 1000,
                base_spread: 0,
                long_spread: 0,
                short_spread: 0,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: pyth_price.twap as i64,
                    last_oracle_price_twap_5min: pyth_price.twap as i64,
                    last_oracle_price: pyth_price.agg.price as i64,
                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };
        market.status = MarketStatus::Active;
        market.amm.max_base_asset_reserve = u128::MAX;
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

        let taker_key = Pubkey::default();
        let taker_authority =
            Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        let user = User {
            authority: taker_authority,
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 50 * PRICE_PRECISION_I64,
                auction_duration: 5,
                price: 50 * PRICE_PRECISION_U64,
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

        let mut maker_orders = [Order::default(); 32];
        maker_orders[0] = Order {
            market_index: 0,
            order_id: 1,
            status: OrderStatus::Open,
            order_type: OrderType::Limit,
            direction: PositionDirection::Short,
            base_asset_amount: BASE_PRECISION_U64,
            slot: 0,
            price: 50 * PRICE_PRECISION_U64,
            post_only: true,
            ..Order::default()
        };
        maker_orders[1] = Order {
            market_index: 0,
            order_id: 2,
            status: OrderStatus::Open,
            order_type: OrderType::Limit,
            direction: PositionDirection::Short,
            base_asset_amount: BASE_PRECISION_U64,
            slot: 0,
            price: 100 * PRICE_PRECISION_U64,
            post_only: true,
            ..Order::default()
        };

        let mut maker = User {
            orders: maker_orders,
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 2,
                open_asks: -2 * BASE_PRECISION_I64,
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
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);

        let makers_and_referrers = UserMap::load_one(&maker_account_info).unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        let mut filler = User::default();

        let maker_order_price_and_indexes = get_maker_orders_info(
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            &makers_and_referrers,
            &taker_key,
            &user.orders[0],
            &mut Some(&mut filler),
            &filler_key,
            0,
            oracle_price,
            None,
            clock.unix_timestamp,
            clock.slot,
        )
        .unwrap();

        assert_eq!(
            maker_order_price_and_indexes,
            vec![(maker_key, 1, 100 * PRICE_PRECISION_U64)]
        );
    }

    #[test]
    fn one_maker_order_canceled_for_being_expired() {
        let clock = Clock {
            slot: 56,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 6,
        };

        let mut pyth_price = get_pyth_price(100, 6);
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            pyth_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                max_spread: 1000,
                base_spread: 0,
                long_spread: 0,
                short_spread: 0,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: pyth_price.twap as i64,
                    last_oracle_price_twap_5min: pyth_price.twap as i64,
                    last_oracle_price: pyth_price.agg.price as i64,
                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };
        market.status = MarketStatus::Active;
        market.amm.max_base_asset_reserve = u128::MAX;
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

        let taker_key = Pubkey::default();
        let taker_authority =
            Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        let user = User {
            authority: taker_authority,
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 50 * PRICE_PRECISION_I64,
                auction_duration: 5,
                price: 100 * PRICE_PRECISION_U64,
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

        let mut maker_orders = [Order::default(); 32];
        maker_orders[0] = Order {
            market_index: 0,
            order_id: 1,
            status: OrderStatus::Open,
            order_type: OrderType::Limit,
            direction: PositionDirection::Short,
            base_asset_amount: BASE_PRECISION_U64,
            slot: 0,
            price: 100 * PRICE_PRECISION_U64,
            max_ts: 1,
            post_only: true,
            ..Order::default()
        };
        maker_orders[1] = Order {
            market_index: 0,
            order_id: 2,
            status: OrderStatus::Open,
            order_type: OrderType::Limit,
            direction: PositionDirection::Short,
            base_asset_amount: BASE_PRECISION_U64,
            slot: 0,
            price: 100 * PRICE_PRECISION_U64,
            post_only: true,
            ..Order::default()
        };

        let mut maker = User {
            orders: maker_orders,
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 2,
                open_asks: -2 * BASE_PRECISION_I64,
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
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);

        let makers_and_referrers = UserMap::load_one(&maker_account_info).unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        let mut filler = User::default();

        let maker_order_price_and_indexes = get_maker_orders_info(
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            &makers_and_referrers,
            &taker_key,
            &user.orders[0],
            &mut Some(&mut filler),
            &filler_key,
            0,
            oracle_price,
            None,
            clock.unix_timestamp,
            clock.slot,
        )
        .unwrap();

        assert_eq!(
            maker_order_price_and_indexes,
            vec![(maker_key, 1, 100 * PRICE_PRECISION_U64)]
        );
    }

    #[test]
    fn one_maker_order_canceled_for_being_reduce_only() {
        let clock = Clock {
            slot: 6,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

        let mut pyth_price = get_pyth_price(100, 6);
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            pyth_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                max_spread: 1000,
                base_spread: 0,
                long_spread: 0,
                short_spread: 0,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: pyth_price.twap as i64,
                    last_oracle_price_twap_5min: pyth_price.twap as i64,
                    last_oracle_price: pyth_price.agg.price as i64,
                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };
        market.status = MarketStatus::Active;
        market.amm.max_base_asset_reserve = u128::MAX;
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

        let taker_key = Pubkey::default();
        let taker_authority =
            Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        let user = User {
            authority: taker_authority,
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 50 * PRICE_PRECISION_I64,
                auction_duration: 5,
                price: 100 * PRICE_PRECISION_U64,
                max_ts: 1,
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

        let mut maker_orders = [Order::default(); 32];
        maker_orders[0] = Order {
            market_index: 0,
            order_id: 1,
            status: OrderStatus::Open,
            order_type: OrderType::Limit,
            direction: PositionDirection::Short,
            base_asset_amount: BASE_PRECISION_U64,
            slot: 0,
            price: 100 * PRICE_PRECISION_U64,
            reduce_only: true,
            ..Order::default()
        };

        let mut maker = User {
            orders: maker_orders,
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: -BASE_PRECISION_I64,
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
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);

        let makers_and_referrers = UserMap::load_one(&maker_account_info).unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        let mut filler = User::default();

        let maker_order_price_and_indexes = get_maker_orders_info(
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            &makers_and_referrers,
            &taker_key,
            &user.orders[0],
            &mut Some(&mut filler),
            &filler_key,
            0,
            oracle_price,
            None,
            clock.unix_timestamp,
            clock.slot,
        )
        .unwrap();

        assert_eq!(maker_order_price_and_indexes, vec![],);
    }

    #[test]
    fn two_makers() {
        let clock = Clock {
            slot: 6,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

        let mut pyth_price = get_pyth_price(100, 6);
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            pyth_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                max_spread: 1000,
                base_spread: 0,
                long_spread: 0,
                short_spread: 0,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: pyth_price.twap as i64,
                    last_oracle_price_twap_5min: pyth_price.twap as i64,
                    last_oracle_price: pyth_price.agg.price as i64,
                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };
        market.status = MarketStatus::Active;
        market.amm.max_base_asset_reserve = u128::MAX;
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

        let taker_key = Pubkey::default();
        let taker_authority =
            Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        let user = User {
            authority: taker_authority,
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 50 * PRICE_PRECISION_I64,
                auction_duration: 5,
                price: 100 * PRICE_PRECISION_U64,
                max_ts: 1,
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

        let mut first_maker = User {
            orders: get_orders!(
                Order {
                    market_index: 0,
                    order_id: 1,
                    status: OrderStatus::Open,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: BASE_PRECISION_U64,
                    slot: 0,
                    price: 100 * PRICE_PRECISION_U64,
                    ..Order::default()
                },
                Order {
                    market_index: 0,
                    order_id: 1,
                    status: OrderStatus::Open,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: BASE_PRECISION_U64,
                    slot: 0,
                    price: 102 * PRICE_PRECISION_U64,
                    ..Order::default()
                }
            ),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 2,
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
        let first_maker_key =
            Pubkey::from_str("My11111111111111111111111111111111111111113").unwrap();
        create_anchor_account_info!(
            first_maker,
            &first_maker_key,
            User,
            first_maker_account_info
        );

        let mut second_maker = User {
            orders: get_orders!(
                Order {
                    market_index: 0,
                    order_id: 1,
                    status: OrderStatus::Open,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: BASE_PRECISION_U64,
                    slot: 0,
                    price: 101 * PRICE_PRECISION_U64,
                    ..Order::default()
                },
                Order {
                    market_index: 0,
                    order_id: 1,
                    status: OrderStatus::Open,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: BASE_PRECISION_U64,
                    slot: 0,
                    price: 103 * PRICE_PRECISION_U64,
                    ..Order::default()
                }
            ),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 2,
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
        let second_maker_key =
            Pubkey::from_str("My11111111111111111111111111111111111111112").unwrap();
        create_anchor_account_info!(
            second_maker,
            &second_maker_key,
            User,
            second_maker_account_info
        );

        let mut makers_and_referrers = UserMap::load_one(&first_maker_account_info).unwrap();
        makers_and_referrers
            .insert(
                second_maker_key,
                AccountLoader::try_from(&second_maker_account_info).unwrap(),
            )
            .unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        let mut filler = User::default();

        let maker_order_price_and_indexes = get_maker_orders_info(
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            &makers_and_referrers,
            &taker_key,
            &user.orders[0],
            &mut Some(&mut filler),
            &filler_key,
            0,
            oracle_price,
            None,
            clock.unix_timestamp,
            clock.slot,
        )
        .unwrap();

        assert_eq!(
            maker_order_price_and_indexes,
            vec![
                (first_maker_key, 0, 100000000),
                (second_maker_key, 0, 101000000),
                (first_maker_key, 1, 102000000),
                (second_maker_key, 1, 103000000),
            ],
        );
    }

    #[test]
    fn jit_maker_order_id() {
        let clock = Clock {
            slot: 6,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

        let mut pyth_price = get_pyth_price(100, 6);
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            pyth_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                max_spread: 1000,
                base_spread: 0,
                long_spread: 0,
                short_spread: 0,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: pyth_price.twap as i64,
                    last_oracle_price_twap_5min: pyth_price.twap as i64,
                    last_oracle_price: pyth_price.agg.price as i64,
                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };
        market.status = MarketStatus::Active;
        market.amm.max_base_asset_reserve = u128::MAX;
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

        let taker_key = Pubkey::default();
        let taker_authority =
            Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        let user = User {
            authority: taker_authority,
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 50 * PRICE_PRECISION_I64,
                auction_duration: 5,
                price: 100 * PRICE_PRECISION_U64,
                max_ts: 1,
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

        let mut first_maker = User {
            orders: get_orders!(
                Order {
                    market_index: 0,
                    order_id: 1,
                    status: OrderStatus::Open,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: BASE_PRECISION_U64,
                    slot: 0,
                    price: 100 * PRICE_PRECISION_U64,
                    ..Order::default()
                },
                Order {
                    market_index: 0,
                    order_id: 2,
                    status: OrderStatus::Open,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: BASE_PRECISION_U64,
                    slot: 0,
                    price: 102 * PRICE_PRECISION_U64,
                    ..Order::default()
                }
            ),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 2,
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
        let first_maker_key =
            Pubkey::from_str("My11111111111111111111111111111111111111113").unwrap();
        create_anchor_account_info!(
            first_maker,
            &first_maker_key,
            User,
            first_maker_account_info
        );

        let makers_and_referrers = UserMap::load_one(&first_maker_account_info).unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        let mut filler = User::default();

        let maker_order_price_and_indexes = get_maker_orders_info(
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            &makers_and_referrers,
            &taker_key,
            &user.orders[0],
            &mut Some(&mut filler),
            &filler_key,
            0,
            oracle_price,
            Some(2),
            clock.unix_timestamp,
            clock.slot,
        )
        .unwrap();

        assert_eq!(
            maker_order_price_and_indexes,
            vec![(first_maker_key, 1, 102000000),],
        );
    }

    #[test]
    fn two_makers_with_max_orders() {
        let clock = Clock {
            slot: 6,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

        let mut pyth_price = get_pyth_price(100, 6);
        let oracle_price = 100 * PRICE_PRECISION_I64;
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            pyth_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                max_spread: 1000,
                base_spread: 0,
                long_spread: 0,
                short_spread: 0,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: pyth_price.twap as i64,
                    last_oracle_price_twap_5min: pyth_price.twap as i64,
                    last_oracle_price: pyth_price.agg.price as i64,
                    ..HistoricalOracleData::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };
        market.status = MarketStatus::Active;
        market.amm.max_base_asset_reserve = u128::MAX;
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

        let taker_key = Pubkey::default();
        let taker_authority =
            Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        let user = User {
            authority: taker_authority,
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 50 * PRICE_PRECISION_I64,
                auction_duration: 5,
                price: 100 * PRICE_PRECISION_U64,
                max_ts: 1,
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

        let mut first_maker = User {
            orders: [Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }; 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 2,
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
        let first_maker_key =
            Pubkey::from_str("My11111111111111111111111111111111111111113").unwrap();
        create_anchor_account_info!(
            first_maker,
            &first_maker_key,
            User,
            first_maker_account_info
        );

        let mut second_maker = User {
            orders: [Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                price: 101 * PRICE_PRECISION_U64,
                ..Order::default()
            }; 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 2,
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
        let second_maker_key =
            Pubkey::from_str("My11111111111111111111111111111111111111112").unwrap();
        create_anchor_account_info!(
            second_maker,
            &second_maker_key,
            User,
            second_maker_account_info
        );

        let mut makers_and_referrers = UserMap::load_one(&first_maker_account_info).unwrap();
        makers_and_referrers
            .insert(
                second_maker_key,
                AccountLoader::try_from(&second_maker_account_info).unwrap(),
            )
            .unwrap();

        let filler_key = Pubkey::from_str("My11111111111111111111111111111111111111111").unwrap();
        let mut filler = User::default();

        let maker_order_price_and_indexes = get_maker_orders_info(
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            &makers_and_referrers,
            &taker_key,
            &user.orders[0],
            &mut Some(&mut filler),
            &filler_key,
            0,
            oracle_price,
            None,
            clock.unix_timestamp,
            clock.slot,
        )
        .unwrap();

        assert_eq!(maker_order_price_and_indexes.len(), 64);
    }
}

pub mod update_trigger_order_params {
    use crate::controller::orders::update_trigger_order_params;
    use crate::state::oracle::OraclePriceData;
    use crate::state::user::{Order, OrderTriggerCondition, OrderType};
    use crate::{PositionDirection, PRICE_PRECISION_I64, PRICE_PRECISION_U64};

    #[test]
    fn test() {
        let mut order = Order {
            order_type: OrderType::TriggerMarket,
            direction: PositionDirection::Long,
            trigger_condition: OrderTriggerCondition::Above,
            ..Order::default()
        };
        let oracle_price_data = OraclePriceData {
            price: 100 * PRICE_PRECISION_I64,
            confidence: 100 * PRICE_PRECISION_U64,
            ..OraclePriceData::default()
        };
        let slot = 10;
        let min_auction_duration = 10;

        update_trigger_order_params(
            &mut order,
            &oracle_price_data,
            slot,
            min_auction_duration,
            None,
        )
        .unwrap();

        assert_eq!(order.slot, slot);
        assert_eq!(order.auction_duration, min_auction_duration);
        assert_eq!(
            order.trigger_condition,
            OrderTriggerCondition::TriggeredAbove
        );
        assert_eq!(order.auction_start_price, 100000000);
        assert_eq!(order.auction_end_price, 100500000);

        let mut order = Order {
            order_type: OrderType::TriggerMarket,
            direction: PositionDirection::Short,
            trigger_condition: OrderTriggerCondition::Below,
            ..Order::default()
        };

        update_trigger_order_params(
            &mut order,
            &oracle_price_data,
            slot,
            min_auction_duration,
            None,
        )
        .unwrap();

        assert_eq!(order.slot, slot);
        assert_eq!(order.auction_duration, min_auction_duration);
        assert_eq!(
            order.trigger_condition,
            OrderTriggerCondition::TriggeredBelow
        );
        assert_eq!(order.auction_start_price, 100000000);
        assert_eq!(order.auction_end_price, 99500000);

        let mut order = Order {
            order_type: OrderType::TriggerMarket,
            direction: PositionDirection::Short,
            trigger_condition: OrderTriggerCondition::TriggeredAbove,
            ..Order::default()
        };

        let err = update_trigger_order_params(
            &mut order,
            &oracle_price_data,
            slot,
            min_auction_duration,
            None,
        );
        assert!(err.is_err());

        let mut order = Order {
            order_type: OrderType::TriggerMarket,
            direction: PositionDirection::Short,
            trigger_condition: OrderTriggerCondition::TriggeredBelow,
            ..Order::default()
        };

        let err = update_trigger_order_params(
            &mut order,
            &oracle_price_data,
            slot,
            min_auction_duration,
            None,
        );
        assert!(err.is_err());
    }
}

mod update_maker_fills_map {
    use crate::controller::orders::update_maker_fills_map;
    use crate::PositionDirection;
    use solana_program::pubkey::Pubkey;
    use std::collections::BTreeMap;

    #[test]
    fn test() {
        let mut map: BTreeMap<Pubkey, i64> = BTreeMap::new();

        let maker_key = Pubkey::new_unique();
        let fill = 100;
        let direction = PositionDirection::Long;
        update_maker_fills_map(&mut map, &maker_key, direction, fill).unwrap();

        assert_eq!(*map.get(&maker_key).unwrap(), fill as i64);

        update_maker_fills_map(&mut map, &maker_key, direction, fill).unwrap();

        assert_eq!(*map.get(&maker_key).unwrap(), 2 * fill as i64);

        let maker_key = Pubkey::new_unique();
        let direction = PositionDirection::Short;
        update_maker_fills_map(&mut map, &maker_key, direction, fill).unwrap();

        assert_eq!(*map.get(&maker_key).unwrap(), -(fill as i64));

        update_maker_fills_map(&mut map, &maker_key, direction, fill).unwrap();

        assert_eq!(*map.get(&maker_key).unwrap(), -2 * fill as i64);
    }
}
