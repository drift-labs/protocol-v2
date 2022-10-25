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
        BASE_PRECISION_I128, BASE_PRECISION_I64, BASE_PRECISION_U64, PRICE_PRECISION_U64,
        QUOTE_PRECISION_I64, QUOTE_PRECISION_U64,
    };
    use crate::state::perp_market::PerpMarket;
    use crate::state::user::{Order, OrderType, PerpPosition, User, UserStats};

    use crate::test_utils::{get_orders, get_positions};

    use super::*;

    #[test]
    fn long_taker_order_fulfilled_start_of_auction() {
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_perp_order_with_match(
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

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -100050000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I64
        );
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
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
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
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_perp_order_with_match(
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

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -160080000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -160 * QUOTE_PRECISION_I64
        );
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
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 48000);
        assert_eq!(maker_stats.maker_volume_30d, 160 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
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
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 200 * PRICE_PRECISION_U64,
                auction_end_price: 100 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_perp_order_with_match(
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

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, 179910000);
        assert_eq!(taker_position.quote_entry_amount, 180 * QUOTE_PRECISION_I64);
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
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_bids, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 54000);
        assert_eq!(maker_stats.maker_volume_30d, 180 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
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
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 200 * PRICE_PRECISION_U64,
                auction_end_price: 100 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_perp_order_with_match(
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

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, 139930000);
        assert_eq!(taker_position.quote_entry_amount, 140 * QUOTE_PRECISION_I64);
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
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_bids, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 42000);
        assert_eq!(maker_stats.maker_volume_30d, 140 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
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
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_perp_order_with_match(
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
                base_asset_amount: BASE_PRECISION_U64,
                auction_start_price: 200 * PRICE_PRECISION_U64,
                auction_end_price: 100 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_perp_order_with_match(
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
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 200 * PRICE_PRECISION_U64,
                auction_end_price: 100 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_perp_order_with_match(
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
                base_asset_amount: BASE_PRECISION_U64,
                auction_start_price: 200 * PRICE_PRECISION_U64,
                auction_end_price: 100 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_perp_order_with_match(
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
                base_asset_amount: 100 * BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_perp_order_with_match(
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

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -120120000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -120 * QUOTE_PRECISION_I64
        );
        assert_eq!(taker_stats.taker_volume_30d, 120 * QUOTE_PRECISION_U64);

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, 120072000);
        assert_eq!(maker_position.quote_entry_amount, 120 * QUOTE_PRECISION_I64);
        assert_eq!(maker_stats.maker_volume_30d, 120 * QUOTE_PRECISION_U64);

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
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
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_perp_order_with_match(
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

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -120120000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -120 * QUOTE_PRECISION_I64
        );
        assert_eq!(taker_stats.taker_volume_30d, 120 * QUOTE_PRECISION_U64);

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, 120072000);
        assert_eq!(maker_position.quote_entry_amount, 120 * QUOTE_PRECISION_I64);
        assert_eq!(maker_stats.maker_volume_30d, 120 * QUOTE_PRECISION_U64);

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
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
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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
                auction_start_price: 200 * PRICE_PRECISION_U64,
                auction_end_price: 100 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_perp_order_with_match(
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

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -150075000);
        assert_eq!(
            taker_position.quote_entry_amount,
            -150 * QUOTE_PRECISION_I64
        );
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
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 45000);
        assert_eq!(maker_stats.maker_volume_30d, 150 * QUOTE_PRECISION_U64);
        assert_eq!(maker.orders[0], Order::default());

        assert_eq!(market.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market.amm.base_asset_amount_long, BASE_PRECISION_I128);
        assert_eq!(market.amm.base_asset_amount_short, -BASE_PRECISION_I128);
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_perp_order_with_match(
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

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, 100030000);
        assert_eq!(maker_position.quote_entry_amount, 100 * QUOTE_PRECISION_I64);
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        fulfill_perp_order_with_match(
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

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(maker_position.quote_asset_amount, -99970000);
        assert_eq!(
            maker_position.quote_entry_amount,
            -100 * QUOTE_PRECISION_I64
        );
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_bids, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 30000);
        assert_eq!(maker.orders[0], Order::default());
        assert_eq!(maker_stats.maker_volume_30d, 100 * QUOTE_PRECISION_U64);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, 99950000);
        assert_eq!(taker_position.quote_entry_amount, 100 * QUOTE_PRECISION_I64);
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
        assert_eq!(market.amm.quote_asset_amount_long, -99970000);
        assert_eq!(market.amm.quote_asset_amount_short, 99950000);
        assert_eq!(market.amm.total_fee, 20000);
        assert_eq!(market.amm.total_fee_minus_distributions, 20000);
        assert_eq!(market.amm.net_revenue_since_last_funding, 20000);
    }
}

pub mod fulfill_order {
    use std::str::FromStr;

    use crate::controller::orders::{fulfill_perp_order, validate_market_within_price_band};
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I64, BASE_PRECISION_U64,
        BID_ASK_SPREAD_PRECISION_I64, PEG_PRECISION, PRICE_PRECISION, PRICE_PRECISION_I64,
        PRICE_PRECISION_U64, QUOTE_PRECISION_I64, QUOTE_PRECISION_U64, SPOT_BALANCE_PRECISION_U64,
        SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::state::{
        OracleGuardRails, PriceDivergenceGuardRails, State, ValidityGuardRails,
    };
    use crate::state::user::{OrderStatus, OrderType, SpotPosition, User, UserStats};
    use crate::test_utils::*;
    use crate::test_utils::{get_orders, get_positions, get_pyth_price, get_spot_positions};

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
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale_for_amm: 10,     // 5s
                    slots_before_stale_for_margin: 120, // 60s
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
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
            .mark_oracle_divergence_numerator = 6;
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
                auction_end_price: 100 * PRICE_PRECISION_U64,
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

        let mut maker = User {
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

        let mut filler = User::default();

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();
        let mut filler_stats = UserStats::default();

        let (base_asset_amount, _, _) = fulfill_perp_order(
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
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            Some(market.amm.historical_oracle_data.last_oracle_price),
            now,
            slot,
            false,
            true,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION_U64);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -100306387);
        assert_eq!(taker_position.quote_entry_amount, -100256258);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50129);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100256237);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64 / 2);
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
        assert_eq!(market_after.amm.quote_asset_amount_long, -100301375);
        assert_eq!(market_after.amm.quote_asset_amount_short, 50020001);

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
                auction_end_price: 100 * PRICE_PRECISION_U64,
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

        let mut maker = User {
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

        let mut filler = User::default();

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();
        let mut filler_stats = UserStats::default();

        let (base_asset_amount, _, _) = fulfill_perp_order(
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
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            Some(market.amm.historical_oracle_data.last_oracle_price),
            now,
            slot,
            false,
            true,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION_U64);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -100331524);
        assert_eq!(taker_position.quote_entry_amount, -100281382);
        assert_eq!(taker_position.open_bids, 0);
        assert_eq!(taker_position.open_orders, 0);
        assert_eq!(taker_stats.fees.total_fee_paid, 50142);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 100281362);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64 / 2);
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
        assert_eq!(market_after.amm.quote_asset_amount_long, -100326511);
        assert_eq!(market_after.amm.quote_asset_amount_short, 50020001);

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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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

        let mut maker = User {
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

        let now = 0_i64;
        let slot = 0_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let (base_asset_amount, _, _) = fulfill_perp_order(
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
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            None,
            now,
            slot,
            false,
            true,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION_U64 / 2);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64 / 2);
        assert_eq!(taker_position.quote_asset_amount, -50025000);
        assert_eq!(taker_position.quote_entry_amount, -50 * QUOTE_PRECISION_I64);
        assert_eq!(taker_position.open_bids, BASE_PRECISION_I64 / 2);
        assert_eq!(taker_position.open_orders, 1);
        assert_eq!(taker_stats.fees.total_fee_paid, 25000);
        assert_eq!(taker_stats.fees.total_referee_discount, 0);
        assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 50 * QUOTE_PRECISION_U64);

        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64 / 2);
        assert_eq!(maker_position.quote_asset_amount, 50015000);
        assert_eq!(maker_position.quote_entry_amount, 50 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_position.open_asks, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15000);
        assert_eq!(maker_stats.maker_volume_30d, 50 * QUOTE_PRECISION_U64);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market_after.amm.base_asset_amount_long, 500000000);
        assert_eq!(market_after.amm.base_asset_amount_short, -500000000);
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
                auction_end_price: 100 * PRICE_PRECISION_U64,
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

        let (base_asset_amount, _, _) = fulfill_perp_order(
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
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            Some(market.amm.historical_oracle_data.last_oracle_price),
            now,
            slot,
            false,
            true,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION_U64);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(taker_position.quote_asset_amount, -104133674);
        assert_eq!(taker_position.quote_entry_amount, -104081633);
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
        assert_eq!(market_after.amm.quote_asset_amount_long, -104133674);
        assert_eq!(market_after.amm.quote_asset_amount_short, 0);
        assert_eq!(market_after.amm.total_fee, 3123572);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 3123572);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 3123572);
    }

    #[test]
    fn fulfill_with_negative_free_collateral() {
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
                base_asset_amount: 100 * BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 100 * PRICE_PRECISION_U64,
                auction_duration: 5,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: 100 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let _maker = User {
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
            ..User::default()
        };

        let fee_structure = get_fee_structure();

        let (taker_key, _, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();

        let (base_asset_amount, _, _) = fulfill_perp_order(
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
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            None,
            now,
            slot,
            false,
            true,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0);

        assert_eq!(taker.perp_positions[0], PerpPosition::default());
        assert_eq!(taker.orders[0], Order::default());
    }

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
            auction_start_price: 100 * PRICE_PRECISION_U64,
            auction_end_price: 200 * PRICE_PRECISION_U64,
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
            auction_start_price: 20000 * PRICE_PRECISION_U64,
            auction_end_price: 20100 * PRICE_PRECISION_U64,
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

        // random
        let now = 1; //80080880_i64;
        let slot = 0; //7893275_u64;

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let taker_before = taker;
        let maker_before = maker;
        let (base_asset_amount, _, _) = fulfill_perp_order(
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
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            None,
            now,
            slot,
            false,
            true,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION_U64 / 2);

        let taker_position = &taker.perp_positions[0].clone();
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I64 / 2);
        assert_eq!(taker_position.quote_asset_amount, -50025000);
        assert_eq!(taker_position.quote_entry_amount, -50 * QUOTE_PRECISION_I64);
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

        let maker_position = &maker.perp_positions[1];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64 / 2);
        assert_eq!(maker_position.quote_asset_amount, 50015000);
        assert_eq!(maker_position.quote_entry_amount, 50 * QUOTE_PRECISION_I64);
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
        assert_eq!(market_after.amm.quote_asset_amount_long, -50025000);
        assert_eq!(market_after.amm.quote_asset_amount_short, 50015000);
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
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I64, BASE_PRECISION_U64, PEG_PRECISION,
        PRICE_PRECISION_U64, SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION,
        SPOT_WEIGHT_PRECISION,
    };
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::oracle::OracleSource;
    use crate::state::perp_market::{PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::state::State;
    use crate::state::user::{OrderStatus, OrderType, SpotPosition, User, UserStats};
    use crate::test_utils::*;
    use crate::test_utils::{
        create_account_info, get_orders, get_positions, get_pyth_price, get_spot_positions,
    };

    use super::*;
    use crate::error::ErrorCode;

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

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
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
                auction_end_price: 102 * PRICE_PRECISION_U64,
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

        let (base_asset_amount, updated_user_state) = fill_perp_order(
            1,
            &state,
            &user_account_loader,
            &user_stats_account_loader,
            &spot_market_map,
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
        assert_eq!(base_asset_amount, 985245000);
        assert!(updated_user_state);
        assert_eq!(user_after.perp_positions[0].open_orders, 0);
        assert_eq!(user_after.perp_positions[0].open_bids, 0);
        assert_eq!(user_after.orders[0], Order::default()); // order canceled

        let filler_after = filler_account_loader.load().unwrap();
        assert_eq!(filler_after.perp_positions[0].quote_asset_amount, 19950);
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
            orders: get_orders(Order {
                market_index: 0,
                order_id: 1,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 102 * PRICE_PRECISION_U64,
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

        let clock = Clock {
            slot: 11,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: 0,
        };

        let (base_asset_amount, _) = fill_perp_order(
            1,
            &state,
            &user_account_loader,
            &user_stats_account_loader,
            &spot_market_map,
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
                auction_end_price: 102 * PRICE_PRECISION_U64,
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
            None,
            None,
            None,
            None,
            None,
            &clock,
        );

        assert_eq!(err, Err(ErrorCode::MaxOpenInterest));
    }
}

#[cfg(test)]
pub mod fulfill_spot_order_with_match {
    use crate::controller::orders::fulfill_spot_order_with_match;
    use crate::controller::position::PositionDirection;
    use crate::math::constants::{
        LAMPORTS_PER_SOL_I64, LAMPORTS_PER_SOL_U64, PRICE_PRECISION_U64, QUOTE_PRECISION_U64,
        SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64,
    };
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::user::{MarketType, Order, OrderType, SpotPosition, User, UserStats};
    use crate::test_utils::get_orders;

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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

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
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

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
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 50 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

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
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 50 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

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
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let base_asset_amount = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 50 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let base_asset_amount = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 50 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let base_asset_amount = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let base_asset_amount = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let base_asset_amount = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();

        let base_asset_amount = fulfill_spot_order_with_match(
            &mut base_market,
            &mut quote_market,
            &mut taker,
            &mut taker_stats,
            0,
            &taker_key,
            &mut maker,
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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
                auction_start_price: 200 * PRICE_PRECISION_U64,
                auction_end_price: 100 * PRICE_PRECISION_U64,
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

        let mut order_records = vec![];

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
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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

        let mut order_records = vec![];

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
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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

        let mut order_records = vec![];

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
            &mut maker_stats,
            0,
            &maker_key,
            None,
            None,
            &filler_key,
            now,
            slot,
            &mut get_oracle_map(),
            &fee_structure,
            &mut order_records,
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
}

pub mod fulfill_spot_order {
    use std::str::FromStr;

    use anchor_lang::prelude::{AccountLoader, Clock};

    use crate::controller::orders::fill_spot_order;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        LAMPORTS_PER_SOL_I64, LAMPORTS_PER_SOL_U64, PRICE_PRECISION_U64, SPOT_BALANCE_PRECISION,
        SPOT_BALANCE_PRECISION_U64,
    };
    use crate::math::margin::calculate_free_collateral;
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::state::State;
    use crate::state::user::{MarketType, OrderStatus, OrderType, SpotPosition, User, UserStats};
    use crate::test_utils::*;
    use crate::test_utils::{get_orders, get_pyth_price};

    use super::*;

    #[test]
    fn fulfill_with_negative_free_collateral() {
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
            oracle: oracle_price_key,
            market_index: 1,
            deposit_balance: SPOT_BALANCE_PRECISION,
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
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
                auction_duration: 5,
                price: 100 * PRICE_PRECISION_U64,
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

        let free_collateral =
            calculate_free_collateral(&taker, &perp_market_map, &spot_market_map, &mut oracle_map)
                .unwrap();
        assert_eq!(free_collateral, -19000000);

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
            &mut None,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0); // cancel should be canceled
        let taker_after = taker_account_loader.load().unwrap();
        assert_eq!(taker_after.orders[0], Order::default()); // order canceled

        let free_collateral = calculate_free_collateral(
            &taker_after,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
        )
        .unwrap();
        assert_eq!(free_collateral, 1000000);

        let maker_after = maker_account_loader.load().unwrap();
        assert_eq!(*maker_after, maker); // maker should not have changed
    }

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
            ..SpotMarket::default_base_market()
        };
        create_anchor_account_info!(base_market, SpotMarket, base_market_account_info);
        let mut second_base_market = SpotMarket {
            market_index: 2,
            deposit_balance: SPOT_BALANCE_PRECISION,
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
            auction_start_price: 100 * PRICE_PRECISION_U64,
            auction_end_price: 200 * PRICE_PRECISION_U64,
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
            auction_start_price: 100 * PRICE_PRECISION_U64,
            auction_end_price: 200 * PRICE_PRECISION_U64,
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
            &mut None,
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
}

pub mod fill_spot_order {
    use std::str::FromStr;

    use anchor_lang::prelude::{AccountLoader, Clock};

    use crate::controller::orders::fill_spot_order;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        LAMPORTS_PER_SOL_I64, LAMPORTS_PER_SOL_U64, PRICE_PRECISION_U64, SPOT_BALANCE_PRECISION,
        SPOT_BALANCE_PRECISION_U64,
    };
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::state::State;
    use crate::state::user::{MarketType, OrderStatus, OrderType, SpotPosition, User, UserStats};
    use crate::test_utils::*;
    use crate::test_utils::{create_account_info, get_orders, get_pyth_price};

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

        let perp_market_map = PerpMarketMap::empty();

        let mut base_market = SpotMarket {
            deposit_balance: SPOT_BALANCE_PRECISION,
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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
                auction_duration: 5,
                price: 100 * PRICE_PRECISION_U64,
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
            &mut None,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 500000000); // half of order filled by maker
        let taker_after = taker_account_loader.load().unwrap();
        assert_eq!(taker_after.orders[0], Order::default()); // order canceled

        let maker_after = taker_account_loader.load().unwrap();
        assert_eq!(maker_after.orders[0], Order::default()); // order completely filled
    }

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
                auction_start_price: 100 * PRICE_PRECISION_U64,
                auction_end_price: 200 * PRICE_PRECISION_U64,
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
            &mut None,
        )
        .unwrap();

        assert_eq!(base_asset_amount, 0); // half of order filled by maker
        let taker_after = taker_account_loader.load().unwrap();
        assert_eq!(taker_after.orders[0], Order::default()); // order expired
    }
}
