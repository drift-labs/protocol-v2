use crate::state::oracle_map::OracleMap;
use crate::state::state::FeeStructure;
use crate::state::user::{MarketPosition, Order};
use anchor_lang::prelude::Pubkey;
use anchor_lang::Owner;

fn get_fee_structure() -> FeeStructure {
    FeeStructure {
        fee_numerator: 5,
        fee_denominator: 10000,
        maker_rebate_numerator: 3,
        maker_rebate_denominator: 5,
        ..FeeStructure::default()
    }
}

fn get_user_keys() -> (Pubkey, Pubkey, Pubkey) {
    (Pubkey::default(), Pubkey::default(), Pubkey::default())
}

fn get_oracle_map<'a>() -> OracleMap<'a> {
    OracleMap::empty()
}

pub mod fulfill_order_with_maker_order {
    use super::*;
    use crate::controller::orders::fulfill_order_with_match;
    use crate::controller::position::PositionDirection;
    use crate::math::constants::{
        BASE_PRECISION, BASE_PRECISION_I128, MARK_PRICE_PRECISION, QUOTE_PRECISION_I128,
        QUOTE_PRECISION_U64,
    };
    use crate::state::market::Market;
    use crate::state::state::FeeStructure;
    use crate::state::user::{MarketPosition, Order, OrderType, User, UserStats};
    use crate::tests::utils::*;

    #[test]
    fn long_taker_order_fulfilled_start_of_auction() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 100 * MARK_PRICE_PRECISION,
                auction_end_price: 200 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                price: 100 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
        )
        .unwrap();

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(taker_position.quote_asset_amount, -100050000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I128
        );
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);
        assert_eq!(taker_stats.taker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(maker_position.quote_asset_amount, 100030000);
        assert_eq!(
            maker_position.quote_entry_amount,
            100 * QUOTE_PRECISION_I128
        );
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.net_base_asset_amount, 0);
        assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount_long, -100050000);
        assert_eq!(market.amm.quote_asset_amount_short, 100030000);
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
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 100 * MARK_PRICE_PRECISION,
                auction_end_price: 200 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                price: 160 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 3_i64;
        let slot = 3_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
        )
        .unwrap();

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(taker_position.quote_asset_amount, -160080000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -160 * QUOTE_PRECISION_I128
        );
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 80000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 160 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(maker_position.quote_asset_amount, 160048000);
        assert_eq!(
            maker_position.quote_entry_amount,
            160 * QUOTE_PRECISION_I128
        );
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 48000);
        assert_eq!(maker_stats.maker_volume_30d, 160 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.net_base_asset_amount, 0);
        assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount_long, -160080000);
        assert_eq!(market.amm.quote_asset_amount_short, 160048000);
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
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 200 * MARK_PRICE_PRECISION,
                auction_end_price: 100 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                price: 180 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
        )
        .unwrap();

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(taker_position.quote_asset_amount, 179910000);
        assert_eq!(
            taker_position.quote_entry_amount,
            180 * QUOTE_PRECISION_I128
        );
        assert_eq!(taker_position.open_asks, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 90000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 180 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(maker_position.quote_asset_amount, -179946000);
        assert_eq!(
            maker_position.quote_entry_amount,
            -180 * QUOTE_PRECISION_I128
        );
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_bids, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 54000);
        assert_eq!(maker_stats.maker_volume_30d, 180 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.net_base_asset_amount, 0);
        assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount_long, -179946000);
        assert_eq!(market.amm.quote_asset_amount_short, 179910000);
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
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 200 * MARK_PRICE_PRECISION,
                auction_end_price: 100 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                price: 140 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 3_i64;
        let slot = 3_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
        )
        .unwrap();

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(taker_position.quote_asset_amount, 139930000);
        assert_eq!(
            taker_position.quote_entry_amount,
            140 * QUOTE_PRECISION_I128
        );
        assert_eq!(taker_position.open_asks, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 70000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 140 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(maker_position.quote_asset_amount, -139958000);
        assert_eq!(
            maker_position.quote_entry_amount,
            -140 * QUOTE_PRECISION_I128
        );
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_bids, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 42000);
        assert_eq!(maker_stats.maker_volume_30d, 140 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.net_base_asset_amount, 0);
        assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount_long, -139958000);
        assert_eq!(market.amm.quote_asset_amount_short, 139930000);
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
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 100 * MARK_PRICE_PRECISION,
                auction_end_price: 200 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                price: 201 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 1_i64;
        let slot = 3_u64;

        let fee_structure = FeeStructure::default();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
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
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                auction_start_price: 200 * MARK_PRICE_PRECISION,
                auction_end_price: 100 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                price: 99 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 1_i64;
        let slot = 3_u64;

        let fee_structure = FeeStructure::default();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
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
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 200 * MARK_PRICE_PRECISION,
                auction_end_price: 100 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                price: 200 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = FeeStructure::default();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
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
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                auction_start_price: 200 * MARK_PRICE_PRECISION,
                auction_end_price: 100 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                price: 200 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = FeeStructure::default();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
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
                base_asset_amount: 100 * BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 100 * MARK_PRICE_PRECISION,
                auction_end_price: 200 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                price: 120 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = FeeStructure::default();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
        )
        .unwrap();

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(taker_position.quote_asset_amount, -120120000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -120 * QUOTE_PRECISION_I128
        );
        assert_eq!(taker_stats.taker_volume_30d, 120 * QUOTE_PRECISION_U64);

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(maker_position.quote_asset_amount, 120072000);
        assert_eq!(
            maker_position.quote_entry_amount,
            120 * QUOTE_PRECISION_I128
        );
        assert_eq!(maker_stats.maker_volume_30d, 120 * QUOTE_PRECISION_U64);

        assert_eq!(market.amm.net_base_asset_amount, 0);
        assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount_long, -120120000);
        assert_eq!(market.amm.quote_asset_amount_short, 120072000);
    }

    #[test]
    fn long_taker_order_smaller_than_maker() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 100 * MARK_PRICE_PRECISION,
                auction_end_price: 200 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: 100 * BASE_PRECISION,
                ts: 0,
                price: 120 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 1_i64;
        let slot = 1_u64;

        let fee_structure = FeeStructure::default();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
        )
        .unwrap();

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(taker_position.quote_asset_amount, -120120000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -120 * QUOTE_PRECISION_I128
        );
        assert_eq!(taker_stats.taker_volume_30d, 120 * QUOTE_PRECISION_U64);

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(maker_position.quote_asset_amount, 120072000);
        assert_eq!(
            maker_position.quote_entry_amount,
            120 * QUOTE_PRECISION_I128
        );
        assert_eq!(maker_stats.maker_volume_30d, 120 * QUOTE_PRECISION_U64);

        assert_eq!(market.amm.net_base_asset_amount, 0);
        assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount_long, -120120000);
        assert_eq!(market.amm.quote_asset_amount_short, 120072000);
    }

    #[test]
    fn double_dutch_auction() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 100 * MARK_PRICE_PRECISION,
                auction_end_price: 200 * MARK_PRICE_PRECISION,
                auction_duration: 10,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 200 * MARK_PRICE_PRECISION,
                auction_end_price: 100 * MARK_PRICE_PRECISION,
                auction_duration: 10,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 5_i64;
        let slot = 5_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
        )
        .unwrap();

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(taker_position.quote_asset_amount, -150075000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -150 * QUOTE_PRECISION_I128
        );
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 75000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 150 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(maker_position.quote_asset_amount, 150045000);
        assert_eq!(
            maker_position.quote_entry_amount,
            150 * QUOTE_PRECISION_I128
        );
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 45000);
        assert_eq!(maker_stats.maker_volume_30d, 150 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.net_base_asset_amount, 0);
        assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount_long, -150075000);
        assert_eq!(market.amm.quote_asset_amount_short, 150045000);
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
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                price: 100 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                price: 150 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 5_i64;
        let slot = 5_u64;

        let fee_structure = get_fee_structure();
        let (maker_key, taker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
        )
        .unwrap();

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(maker_position.quote_asset_amount, 100030000);
        assert_eq!(
            maker_position.quote_entry_amount,
            100 * QUOTE_PRECISION_I128
        );
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(taker_position.quote_asset_amount, -100050000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I128
        );
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        assert_eq!(market.amm.net_base_asset_amount, 0);
        assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount_long, -100050000);
        assert_eq!(market.amm.quote_asset_amount_short, 100030000);
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
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                price: 100 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                price: 50 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut market = Market::default_test();

        let now = 5_i64;
        let slot = 5_u64;

        let fee_structure = get_fee_structure();

        let (maker_key, taker_key, filler_key) = get_user_keys();

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_order_with_match(
            &mut market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            &mut None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            0,
            None,
            now,
            slot,
            &fee_structure,
            &mut get_oracle_map(),
            &mut order_records,
        )
        .unwrap();

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(maker_position.quote_asset_amount, -99970000);
        assert_eq!(
            maker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I128
        );
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_bids, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker.orders[0], Order::default());
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(taker_position.quote_asset_amount, 99950000);
        assert_eq!(
            taker_position.quote_entry_amount,
            100 * QUOTE_PRECISION_I128
        );
        assert_eq!(taker_position.open_asks, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(taker.orders[0], Order::default());

        assert_eq!(market.amm.net_base_asset_amount, 0);
        assert_eq!(market.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.base_asset_amount_short, -BASE_PRECISION_I128);
        assert_eq!(market.amm.quote_asset_amount_long, -99970000);
        assert_eq!(market.amm.quote_asset_amount_short, 99950000);
        assert_eq!(market.amm.total_fee, 20000);
        assert_eq!(market.amm.total_fee_minus_distributions, 20000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
    }
}

pub mod fulfill_order {
    use super::*;
    use crate::controller::orders::fulfill_order;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION,
        BANK_WEIGHT_PRECISION, BASE_PRECISION, BASE_PRECISION_I128, MARK_PRICE_PRECISION,
        PEG_PRECISION, QUOTE_PRECISION_I128, QUOTE_PRECISION_U64,
    };
    use crate::math::margin::calculate_free_collateral;
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::BankMap;
    use crate::state::market::{Market, AMM};
    use crate::state::market_map::MarketMap;
    use crate::state::oracle::OracleSource;
    use crate::state::user::{OrderStatus, OrderType, User, UserBankBalance, UserStats};
    use crate::tests::utils::*;
    use std::str::FromStr;

    #[test]
    fn fulfill_with_amm_and_maker() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(100, 10);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot).unwrap();

        let mut market = Market {
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
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                base_spread: 100,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            initialized: true,
            ..Market::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 100 * MARK_PRICE_PRECISION,
                auction_duration: 0,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION / 2,
                ts: 0,
                price: 100 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128 / 2,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let mut filler = User::default();

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();
        let mut filler_stats = UserStats::default();

        let (base_asset_amount, _, _) = fulfill_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &mut Some(&mut maker),
            &mut Some(&mut maker_stats),
            Some(0),
            Some(&maker_key),
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            &mut None,
            &mut None,
            &bank_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            None,
            now,
            slot,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION);

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(taker_position.quote_asset_amount, -100301382);
        assert_eq!(taker_position.quote_entry_amount, -100251257);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50125);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100251237);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I128 / 2);
        assert_eq!(maker_position.quote_asset_amount, 50015000);
        assert_eq!(maker_position.quote_entry_amount, 50 * QUOTE_PRECISION_I128);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15000);
        assert_eq!(maker_stats.maker_volume_30d, 50 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, 5000000000000);
        assert_eq!(market_after.base_asset_amount_long, 10000000000000);
        assert_eq!(market_after.base_asset_amount_short, -5000000000000);
        assert_eq!(market_after.amm.quote_asset_amount_long, -100296370);
        assert_eq!(market_after.amm.quote_asset_amount_short, 50015000);
        assert_eq!(market_after.amm.total_fee, 30113);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 30113);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 30113);

        assert_eq!(filler_stats.filler_volume_30d, 100251237);
        assert_eq!(filler.positions[0].quote_asset_amount, 5012);
    }

    #[test]
    fn fulfill_with_maker_with_auction_incomplete() {
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                base_asset_amount_step_size: 1,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            initialized: true,
            ..Market::default_test()
        };
        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        let mut oracle_map = get_oracle_map();

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 100 * MARK_PRICE_PRECISION,
                auction_end_price: 200 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let mut maker = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION / 2,
                ts: 0,
                price: 100 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128 / 2,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let now = 0_i64;
        let slot = 0_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _, _) = fulfill_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &mut Some(&mut maker),
            &mut Some(&mut maker_stats),
            Some(0),
            Some(&maker_key),
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            &mut None,
            &bank_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            None,
            now,
            slot,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION / 2);

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I128 / 2);
        assert_eq!(taker_position.quote_asset_amount, -50025000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -50 * QUOTE_PRECISION_I128
        );
        assert_eq!(taker_position.open_bids, BASE_PRECISION_I128 / 2);
        assert_eq!(taker_position.open_orders, 1);
        assert_eq!(taker_stats.fees.total_fee_paid, 25000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 50 * QUOTE_PRECISION_U64);

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I128 / 2);
        assert_eq!(maker_position.quote_asset_amount, 50015000);
        assert_eq!(maker_position.quote_entry_amount, 50 * QUOTE_PRECISION_I128);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15000);
        assert_eq!(maker_stats.maker_volume_30d, 50 * QUOTE_PRECISION_U64);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, 0);
        assert_eq!(market_after.base_asset_amount_long, 5000000000000);
        assert_eq!(market_after.base_asset_amount_short, -5000000000000);
        assert_eq!(market_after.amm.quote_asset_amount_long, -50025000);
        assert_eq!(market_after.amm.quote_asset_amount_short, 50015000);
        assert_eq!(market_after.amm.total_fee, 10000);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 10000);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 10000);
    }

    #[test]
    fn fulfill_with_amm_end_of_auction() {
        let now = 0_i64;
        let slot = 6_u64;

        let mut oracle_price = get_pyth_price(100, 10);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot).unwrap();

        let mut market = Market {
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
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            initialized: true,
            ..Market::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 100 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let fee_structure = get_fee_structure();

        let (taker_key, _, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();

        let (base_asset_amount, _, _) = fulfill_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &mut None,
            &mut None,
            None,
            None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            &mut None,
            &bank_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            None,
            now,
            slot,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION);

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(taker_position.quote_asset_amount, -104133673);
        assert_eq!(taker_position.quote_entry_amount, -104081633);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 52040);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 104081633);
        assert_eq!(taker.orders[0], Order::default());

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, 10000000000000);
        assert_eq!(market_after.base_asset_amount_long, 10000000000000);
        assert_eq!(market_after.base_asset_amount_short, 0);
        assert_eq!(market_after.amm.quote_asset_amount_long, -104133673);
        assert_eq!(market_after.amm.quote_asset_amount_short, 0);
        assert_eq!(market_after.amm.total_fee, 3123571);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 3123571);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 3123571);
    }

    #[test]
    fn fulfill_with_negative_free_collateral() {
        let now = 0_i64;
        let slot = 6_u64;

        let mut oracle_price = get_pyth_price(100, 10);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot).unwrap();

        let mut market = Market {
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
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            initialized: true,
            ..Market::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: 100 * BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 100 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 1 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let fee_structure = get_fee_structure();

        let (taker_key, _, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();

        let (base_asset_amount, _, _) = fulfill_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &mut None,
            &mut None,
            None,
            None,
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            &mut None,
            &bank_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            None,
            now,
            slot,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0);

        assert_eq!(taker.positions[0], MarketPosition::default());
        assert_eq!(taker.orders[0], Order::default());
    }

    #[test]
    fn fulfill_users_with_multiple_orders_and_markets() {
        let mut sol_market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                base_asset_amount_step_size: 1,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            initialized: true,
            ..Market::default()
        };
        create_anchor_account_info!(sol_market, Market, sol_market_account_info);
        let mut btc_market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 20000 * PEG_PRECISION,
                base_asset_amount_step_size: 1,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            initialized: true,
            market_index: 1,
            ..Market::default()
        };
        create_anchor_account_info!(btc_market, Market, btc_market_account_info);
        let market_map = MarketMap::load_multiple(
            vec![&sol_market_account_info, &btc_market_account_info],
            true,
        )
        .unwrap();

        let mut bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        let mut oracle_map = get_oracle_map();

        let mut taker_orders = [Order::default(); 32];
        taker_orders[0] = Order {
            market_index: 0,
            status: OrderStatus::Open,
            order_type: OrderType::Market,
            direction: PositionDirection::Long,
            base_asset_amount: BASE_PRECISION,
            ts: 0,
            slot: 0,
            auction_start_price: 100 * MARK_PRICE_PRECISION,
            auction_end_price: 200 * MARK_PRICE_PRECISION,
            auction_duration: 5,
            ..Order::default()
        };
        taker_orders[1] = Order {
            market_index: 1,
            status: OrderStatus::Open,
            order_type: OrderType::Market,
            direction: PositionDirection::Long,
            base_asset_amount: BASE_PRECISION,
            ts: 0,
            slot: 0,
            auction_start_price: 20000 * MARK_PRICE_PRECISION,
            auction_end_price: 20100 * MARK_PRICE_PRECISION,
            auction_duration: 5,
            ..Order::default()
        };

        // Taker has sol order and position at index 0, btc at index 1
        let mut taker_positions = [MarketPosition::default(); 5];
        taker_positions[0] = MarketPosition {
            market_index: 0,
            open_orders: 1,
            open_bids: BASE_PRECISION_I128,
            ..MarketPosition::default()
        };
        taker_positions[1] = MarketPosition {
            market_index: 1,
            open_orders: 1,
            open_bids: BASE_PRECISION_I128,
            ..MarketPosition::default()
        };

        let mut taker = User {
            orders: taker_orders,
            positions: taker_positions,
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        // Maker has sol order and position at index 1, btc at index 1
        let mut maker_orders = [Order::default(); 32];
        maker_orders[0] = Order {
            market_index: 1,
            post_only: true,
            order_type: OrderType::Limit,
            direction: PositionDirection::Short,
            base_asset_amount: BASE_PRECISION / 2,
            ts: 0,
            price: 20000 * MARK_PRICE_PRECISION,
            ..Order::default()
        };
        maker_orders[1] = Order {
            market_index: 0,
            post_only: true,
            order_type: OrderType::Limit,
            direction: PositionDirection::Short,
            base_asset_amount: BASE_PRECISION / 2,
            ts: 0,
            price: 100 * MARK_PRICE_PRECISION,
            ..Order::default()
        };

        let mut maker_positions = [MarketPosition::default(); 5];
        maker_positions[0] = MarketPosition {
            market_index: 1,
            open_orders: 1,
            open_asks: -BASE_PRECISION_I128 / 2,
            ..MarketPosition::default()
        };
        maker_positions[1] = MarketPosition {
            market_index: 0,
            open_orders: 1,
            open_asks: -BASE_PRECISION_I128 / 2,
            ..MarketPosition::default()
        };

        let mut maker = User {
            orders: maker_orders,
            positions: maker_positions,
            ..User::default()
        };

        let now = 0_i64;
        let slot = 0_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_before = taker;
        let maker_before = maker;
        let (base_asset_amount, _, _) = fulfill_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &mut Some(&mut maker),
            &mut Some(&mut maker_stats),
            Some(1),
            Some(&maker_key),
            &mut None,
            &filler_key,
            &mut None,
            &mut None,
            &mut None,
            &bank_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            None,
            now,
            slot,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION / 2);

        let taker_position = &taker.positions[0].clone();
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I128 / 2);
        assert_eq!(taker_position.quote_asset_amount, -50025000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -50 * QUOTE_PRECISION_I128
        );
        assert_eq!(taker_position.open_bids, BASE_PRECISION_I128 / 2);
        assert_eq!(taker_position.open_orders, 1);
        assert_eq!(taker_stats.fees.total_fee_paid, 25000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 50 * QUOTE_PRECISION_U64);

        let taker_order = &taker.orders[0].clone();
        assert_eq!(taker_order.base_asset_amount_filled, BASE_PRECISION / 2);
        assert_eq!(taker_order.quote_asset_amount_filled, 50000000);
        assert_eq!(taker_order.fee, 25000);

        // BTC Market shouldnt be affected
        assert_eq!(taker.positions[1], taker_before.positions[1]);
        assert_eq!(taker.orders[1], taker_before.orders[1]);

        let maker_position = &maker.positions[1];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I128 / 2);
        assert_eq!(maker_position.quote_asset_amount, 50015000);
        assert_eq!(maker_position.quote_entry_amount, 50 * QUOTE_PRECISION_I128);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15000);
        assert_eq!(maker_stats.maker_volume_30d, 50 * QUOTE_PRECISION_U64);

        assert_eq!(maker.orders[1], Order::default());

        // BTC Market shouldnt be affected
        assert_eq!(maker.positions[0], maker_before.positions[0]);
        assert_eq!(maker.orders[0], maker_before.orders[0]);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, 0);
        assert_eq!(market_after.base_asset_amount_long, 5000000000000);
        assert_eq!(market_after.base_asset_amount_short, -5000000000000);
        assert_eq!(market_after.amm.quote_asset_amount_long, -50025000);
        assert_eq!(market_after.amm.quote_asset_amount_short, 50015000);
        assert_eq!(market_after.amm.total_fee, 10000);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 10000);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 10000);
    }
}

pub mod fill_order {
    use super::*;
    use crate::controller::orders::fill_order;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION,
        BANK_WEIGHT_PRECISION, BASE_PRECISION, BASE_PRECISION_I128, MARK_PRICE_PRECISION,
        PEG_PRECISION,
    };
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::BankMap;
    use crate::state::market::{Market, AMM};
    use crate::state::market_map::MarketMap;
    use crate::state::oracle::OracleSource;
    use crate::state::state::State;
    use crate::state::user::{OrderStatus, OrderType, User, UserBankBalance, UserStats};
    use crate::tests::utils::create_account_info;
    use crate::tests::utils::*;
    use anchor_lang::prelude::{AccountLoader, Clock};
    use std::str::FromStr;

    #[test]
    fn cancel_order_after_fulfill() {
        let clock = Clock {
            slot: 6,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

        let mut oracle_price = get_pyth_price(100, 10);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot).unwrap();

        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                last_oracle_price_twap: oracle_price.twap as i128,
                max_spread: 1000,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            initialized: true,
            ..Market::default()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;
        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 102 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                price: 102 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
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
            min_auction_duration: 1,
            max_auction_duration: 10,
            ..State::default()
        };

        let (base_asset_amount, updated_user_state) = fill_order(
            1,
            &state,
            &user_account_loader,
            &user_stats_account_loader,
            &bank_map,
            &market_map,
            &mut oracle_map,
            &filler_account_loader,
            &filler_stats_account_loader,
            None,
            None,
            None,
            None,
            None,
            &clock,
        )
        .unwrap();

        let user_after = user_account_loader.load().unwrap();
        assert_eq!(base_asset_amount, 9852450000000);
        assert!(updated_user_state);
        assert_eq!(user_after.positions[0].open_orders, 0);
        assert_eq!(user_after.positions[0].open_bids, 0);
        assert_eq!(user_after.orders[0], Order::default()); // order canceled

        let filler_after = filler_account_loader.load().unwrap();
        assert_eq!(filler_after.positions[0].quote_asset_amount, 20000);
    }

    #[test]
    fn expire_order() {
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 100,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            initialized: true,
            ..Market::default()
        };
        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        let mut oracle_map = get_oracle_map();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 102 * MARK_PRICE_PRECISION,
                auction_duration: 5,
                price: 102 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
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
            min_auction_duration: 1,
            max_auction_duration: 10,
            ..State::default()
        };

        let clock = Clock {
            slot: 11,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

        let (base_asset_amount, _) = fill_order(
            1,
            &state,
            &user_account_loader,
            &user_stats_account_loader,
            &bank_map,
            &market_map,
            &mut oracle_map,
            &filler_account_loader,
            &filler_stats_account_loader,
            None,
            None,
            None,
            None,
            None,
            &clock,
        )
        .unwrap();

        let user_after = user_account_loader.load().unwrap();
        assert_eq!(base_asset_amount, 0);
        assert_eq!(user_after.positions[0].open_orders, 0);
        assert_eq!(user_after.positions[0].open_bids, 0);
        assert_eq!(user_after.positions[0].quote_asset_amount, -10000);
        assert_eq!(user_after.orders[0], Order::default()); // order canceled

        let filler_after = filler_account_loader.load().unwrap();
        assert_eq!(filler_after.positions[0].quote_asset_amount, 10000);
    }
}
