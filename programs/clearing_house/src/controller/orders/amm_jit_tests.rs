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

#[cfg(test)]
pub mod amm_jit {
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
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::BankMap;
    use crate::state::market::{Market, AMM};
    use crate::state::market_map::MarketMap;
    use crate::state::oracle::OracleSource;
    use crate::state::user::{OrderStatus, OrderType, User, UserBankBalance, UserStats};
    use crate::tests::utils::*;
    use std::str::FromStr;

    #[test]
    fn no_fulfill_with_amm_jit_taker_long() {
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

        // net users are short
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                net_base_asset_amount: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                ..AMM::default()
            },
            base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
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
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        // taker wants to go long (would improve balance)
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
        assert_eq!(taker_stats.taker_volume_30d, 102284244);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I128 / 2);
        assert_eq!(maker_position.quote_asset_amount, 50015000);
        assert_eq!(maker_position.quote_entry_amount, 50 * QUOTE_PRECISION_I128);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15000);
        assert_eq!(maker_stats.maker_volume_30d, 50 * QUOTE_PRECISION_U64);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, 10000000000000);
        assert_eq!(market_after.amm.total_fee, 2064035);
        assert_eq!(filler_stats.filler_volume_30d, 102284244);
    }

    #[test]
    fn fulfill_with_amm_jit_taker_long_max_amount() {
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

        // net users are short
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                net_base_asset_amount: -((AMM_RESERVE_PRECISION / 2) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                ..AMM::default()
            },
            base_asset_amount_short: -((AMM_RESERVE_PRECISION / 2) as i128),
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
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        // taker wants to go long (would improve balance)
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION * 2, // if amm takes half it would flip
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
                open_bids: BASE_PRECISION_I128 * 2,
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
                base_asset_amount: BASE_PRECISION * 2, // maker wants full = amm wants BASE_PERCISION
                ts: 0,
                price: 100 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128 * 2,
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

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        fulfill_order(
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

        let market_after = market_map.get_ref(&0).unwrap();
        // nets to zero
        assert_eq!(market_after.amm.net_base_asset_amount, 0);

        let maker_position = &maker.positions[0];
        // maker got (full - net_baa)
        assert_eq!(
            maker_position.base_asset_amount,
            -BASE_PRECISION_I128 * 2 - market.amm.net_base_asset_amount
        );
    }

    #[test]
    fn fulfill_with_amm_jit_taker_short_max_amount() {
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

        // net users are short
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                net_base_asset_amount: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                ..AMM::default()
            },
            base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
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
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        // taker wants to go long (would improve balance)
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION * 2, // if amm takes half it would flip
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
                open_asks: -BASE_PRECISION_I128 * 2,
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
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION * 2, // maker wants full = amm wants BASE_PERCISION
                ts: 0,
                price: 100 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128 * 2,
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

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        fulfill_order(
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

        let market_after = market_map.get_ref(&0).unwrap();
        // nets to zero
        assert_eq!(market_after.amm.net_base_asset_amount, 0);

        let maker_position = &maker.positions[0];
        // maker got (full - net_baa)
        assert_eq!(
            maker_position.base_asset_amount,
            BASE_PRECISION_I128 * 2 - market.amm.net_base_asset_amount
        );
    }

    #[test]
    fn no_fulfill_with_amm_jit_taker_short() {
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

        // amm is short
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                net_base_asset_amount: -((AMM_RESERVE_PRECISION / 2) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                ..AMM::default()
            },
            base_asset_amount_short: -((AMM_RESERVE_PRECISION / 2) as i128),
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
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Short, // doesnt improve balance
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
                open_asks: -BASE_PRECISION_I128,
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
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION / 2,
                ts: 0,
                price: 100 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128 / 2,
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
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, BASE_PRECISION_I128 / 2);
        assert_eq!(maker_position.quote_asset_amount, -49985000);
        assert_eq!(
            maker_position.quote_entry_amount,
            -50 * QUOTE_PRECISION_I128
        );
        assert_eq!(maker_position.open_orders, 0);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, -10000000000000);
    }

    #[test]
    fn fulfill_with_amm_jit_taker_short() {
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

        // net users are short
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                net_base_asset_amount: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                ..AMM::default()
            },
            base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
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
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        // taker wants to go long (would improve balance)
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
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
                open_asks: -BASE_PRECISION_I128,
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
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION / 2,
                ts: 0,
                price: 100 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128 / 2,
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

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

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
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I128);
        assert_eq!(taker_stats.taker_volume_30d, 97283221);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.positions[0];
        assert_eq!(
            maker_position.base_asset_amount,
            BASE_PRECISION_I128 / 2 / 2
        );
        assert_eq!(maker_position.quote_asset_amount, -24992500);
        assert_eq!(
            maker_position.quote_entry_amount,
            -50 / 2 * QUOTE_PRECISION_I128
        );
        assert_eq!(maker_position.open_orders, 1);
        assert_eq!(maker_position.open_bids, 2500000000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15000 / 2);
        assert_eq!(maker_stats.maker_volume_30d, 50 / 2 * QUOTE_PRECISION_U64);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, -2500000000000);

        let quote_asset_amount_surplus = market_after.amm.total_mm_fee - market.amm.total_mm_fee;

        assert!(quote_asset_amount_surplus > 0);
        assert_eq!(quote_asset_amount_surplus, 677570);

        assert_eq!(market_after.amm.total_fee, 713847);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 713847);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 713847);
        assert_eq!(market_after.amm.total_mm_fee, 677570);
        assert_eq!(market_after.amm.total_exchange_fee, 36141);
        assert_eq!(market_after.amm.total_fee_withdrawn, 0);

        assert_eq!(filler_stats.filler_volume_30d, 97283221);
    }

    #[test]
    fn fulfill_with_amm_jit_taker_long() {
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

        // net users are short
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                net_base_asset_amount: -((AMM_RESERVE_PRECISION / 2) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                ..AMM::default()
            },
            base_asset_amount_short: -((AMM_RESERVE_PRECISION / 2) as i128),
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
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        // taker wants to go long (would improve balance)
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

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

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
        assert_eq!(taker_stats.taker_volume_30d, 102784235);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.positions[0];
        assert_eq!(
            maker_position.base_asset_amount,
            -BASE_PRECISION_I128 / 2 / 2
        );
        assert_eq!(maker_position.quote_asset_amount, 50015000 / 2);
        assert_eq!(
            maker_position.quote_entry_amount,
            50 / 2 * QUOTE_PRECISION_I128
        );
        assert_eq!(maker_position.open_orders, 1);
        assert_eq!(maker_position.open_asks, -2500000000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15000 / 2);
        assert_eq!(maker_stats.maker_volume_30d, 50 / 2 * QUOTE_PRECISION_U64);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, 2500000000000);

        // mm gains from trade
        let quote_asset_amount_surplus = market_after.amm.total_mm_fee - market.amm.total_mm_fee;

        assert!(quote_asset_amount_surplus > 0);
        assert_eq!(quote_asset_amount_surplus, 697892);

        assert_eq!(market_after.amm.total_fee, 736645);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 736645);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 736645);
        assert_eq!(market_after.amm.total_mm_fee, 697892);
        assert_eq!(market_after.amm.total_exchange_fee, 38892);
        assert_eq!(market_after.amm.total_fee_withdrawn, 0);

        assert_eq!(filler_stats.filler_volume_30d, 102784235);
    }

    #[test]
    fn fulfill_with_amm_jit_taker_long_neg_qas() {
        let now = 0_i64;
        let slot = 10_u64;

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

        // net users are short
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                net_base_asset_amount: -((AMM_RESERVE_PRECISION / 2) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                ..AMM::default()
            },
            base_asset_amount_short: -((AMM_RESERVE_PRECISION / 2) as i128),
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
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        // taker wants to go long (would improve balance)
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
                auction_duration: 50, // !! amm will bid before the ask spread price
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
                price: 10 * MARK_PRICE_PRECISION,
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

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        // fulfill with match
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

        assert_eq!(base_asset_amount, BASE_PRECISION / 2); // auctions not over so no amm fill

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, BASE_PRECISION_I128 / 2);
        assert_eq!(taker_stats.taker_volume_30d, 7499999);

        let maker_position = &maker.positions[0];
        assert_eq!(
            maker_position.base_asset_amount,
            -BASE_PRECISION_I128 / 2 / 2
        );
        assert_eq!(maker_position.quote_asset_amount, 5001500 / 2);
        assert_eq!(maker_position.quote_entry_amount, 2500000);
        assert_eq!(maker_position.open_orders, 1);
        assert_eq!(maker_position.open_asks, -2500000000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 1500 / 2);
        assert_eq!(maker_stats.maker_volume_30d, 2500000);
        assert_eq!(
            maker_position.quote_entry_amount + maker_stats.fees.total_fee_rebate as i128,
            maker_position.quote_asset_amount
        );

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, -2500000000000);

        // mm gains from trade
        let quote_asset_amount_surplus = market_after.amm.total_mm_fee - market.amm.total_mm_fee;

        assert!(quote_asset_amount_surplus < 0);
        assert_eq!(quote_asset_amount_surplus, -21582278);

        assert_eq!(market_after.amm.total_fee, -21579653);
        assert_eq!(market_after.amm.total_fee_minus_distributions, -21579653);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, -21579653);
        assert_eq!(market_after.amm.total_mm_fee, -21582278);
        assert_eq!(market_after.amm.total_exchange_fee, 2500);
        assert_eq!(market_after.amm.total_fee_withdrawn, 0);

        assert_eq!(filler_stats.filler_volume_30d, 7499999);
    }

    #[test]
    fn fulfill_with_amm_jit_taker_short_neg_qas() {
        let now = 0_i64;
        let slot = 10_u64;

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

        // net users are short
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                net_base_asset_amount: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                ..AMM::default()
            },
            base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
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
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        // taker wants to go long (would improve balance)
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_end_price: 0,
                auction_start_price: 200 * MARK_PRICE_PRECISION,
                auction_duration: 50, // !! amm will bid before the ask spread price
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128,
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
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION / 2,
                ts: 0,
                price: 200 * MARK_PRICE_PRECISION,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128 / 2,
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

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        // fulfill with match
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

        assert_eq!(base_asset_amount, BASE_PRECISION / 2); // auctions not over so no amm fill

        let taker_position = &taker.positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I128 / 2);
        assert_eq!(taker_stats.taker_volume_30d, 89999984);

        let maker_position = &maker.positions[0];
        assert_eq!(
            maker_position.base_asset_amount,
            BASE_PRECISION_I128 / 2 / 2
        );
        assert_eq!(maker_position.quote_asset_amount, -49985000);
        assert_eq!(maker_position.quote_entry_amount, -50000000);
        assert_eq!(maker_position.open_orders, 1);
        assert_eq!(maker_position.open_bids, 2500000000000);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15000);
        assert_eq!(maker_stats.maker_volume_30d, 50000000);
        assert_eq!(
            maker_position.quote_entry_amount + maker_stats.fees.total_fee_rebate as i128,
            maker_position.quote_asset_amount
        );

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, 2500000000000);

        // mm gains from trade
        let quote_asset_amount_surplus = market_after.amm.total_mm_fee - market.amm.total_mm_fee;

        assert!(quote_asset_amount_surplus < 0);
        assert_eq!(quote_asset_amount_surplus, -16543210);

        assert_eq!(market_after.amm.total_fee, -16517710);
        assert_eq!(market_after.amm.total_fee_minus_distributions, -16517710);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, -16517710);
        assert_eq!(market_after.amm.total_mm_fee, -16543210);
        assert_eq!(market_after.amm.total_exchange_fee, 20000);
        assert_eq!(market_after.amm.total_fee_withdrawn, 0);

        assert_eq!(filler_stats.filler_volume_30d, 89999984);
    }

    #[allow(clippy::comparison_chain)]
    #[test]
    fn fulfill_with_amm_jit_full_long() {
        let now = 0_i64;
        let mut slot = 0_u64;

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

        // net users are short
        let reserves = 5 * AMM_RESERVE_PRECISION;
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: reserves,
                quote_asset_reserve: reserves,
                net_base_asset_amount: -(100 * AMM_RESERVE_PRECISION as i128),
                sqrt_k: reserves,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                base_spread: 5000,
                max_spread: 1000000,
                long_spread: 50000,
                short_spread: 50000,
                amm_jit_intensity: 100,
                ..AMM::default()
            },
            base_asset_amount_short: -(100 * AMM_RESERVE_PRECISION as i128),
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            initialized: true,
            ..Market::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let (new_ask_base_asset_reserve, new_ask_quote_asset_reserve) =
            crate::amm::calculate_spread_reserves(&market.amm, PositionDirection::Long).unwrap();
        let (new_bid_base_asset_reserve, new_bid_quote_asset_reserve) =
            crate::amm::calculate_spread_reserves(&market.amm, PositionDirection::Short).unwrap();
        market.amm.ask_base_asset_reserve = new_ask_base_asset_reserve;
        market.amm.bid_base_asset_reserve = new_bid_base_asset_reserve;
        market.amm.ask_quote_asset_reserve = new_ask_quote_asset_reserve;
        market.amm.bid_quote_asset_reserve = new_bid_quote_asset_reserve;

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

        // taker wants to go long (would improve balance)
        let auction_duration = 50;
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: 100 * BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_duration,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: -100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let auction_start_price =
            crate::math::auction::calculate_auction_start_price(&market, PositionDirection::Long)
                .unwrap();
        let auction_end_price = crate::math::auction::calculate_auction_end_price(
            &market,
            PositionDirection::Long,
            BASE_PRECISION,
        )
        .unwrap();
        taker.orders[0].auction_start_price = auction_start_price;
        taker.orders[0].auction_end_price = auction_end_price;
        println!("start stop {} {}", auction_start_price, auction_end_price);

        let mut filler = User::default();
        let fee_structure = get_fee_structure();
        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();
        let mut filler_stats = UserStats::default();

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        let (mut neg, mut pos, mut none) = (false, false, false);
        let mut prev_mm_fee = 0;
        let mut prev_net_baa = market.amm.net_base_asset_amount;
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
                crate::math::auction::calculate_auction_price(&taker.orders[0], slot).unwrap();
            let baa = market.amm.base_asset_amount_step_size * 4;

            let (mark, ask, bid) = {
                let market = market_map.get_ref(&0).unwrap();
                let mark = market.amm.mark_price().unwrap();
                let ask = market.amm.ask_price(mark).unwrap();
                let bid = market.amm.bid_price(mark).unwrap();
                (mark, ask, bid)
            };
            println!("mark: {} bid ask: {} {}", mark, bid, ask);

            let (_, _, _quote_asset_amount_surplus, _) =
                crate::controller::position::update_position_with_base_asset_amount(
                    baa / 2, // amm takes on half
                    PositionDirection::Long,
                    &mut market_map.get_ref_mut(&0).unwrap(),
                    &mut taker,
                    0,
                    mark,
                    now,
                    Some(auction_price),
                )
                .unwrap();

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: baa,
                    ts: 0,
                    price: auction_price,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_asks: -(baa as i128),
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            // fulfill with match
            fulfill_order(
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

            let market_after = market_map.get_ref(&0).unwrap();
            let quote_asset_amount_surplus = market_after.amm.total_mm_fee - prev_mm_fee;
            prev_mm_fee = market_after.amm.total_mm_fee;

            // imbalance decreases
            assert!(market_after.amm.net_base_asset_amount.abs() < prev_net_baa.abs());
            prev_net_baa = market_after.amm.net_base_asset_amount;

            println!("estim qas: {}", _quote_asset_amount_surplus);
            println!(
                "slot {} auction: {} surplus: {}",
                slot, auction_price, quote_asset_amount_surplus
            );

            assert_eq!(_quote_asset_amount_surplus, quote_asset_amount_surplus);

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
        assert!(none);

        println!("{} {} {}", neg, pos, none);
    }

    #[allow(clippy::comparison_chain)]
    #[test]
    fn fulfill_with_amm_jit_full_short() {
        let now = 0_i64;
        let mut slot = 0_u64;

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

        // net users are short
        let reserves = 5 * AMM_RESERVE_PRECISION;
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: reserves,
                quote_asset_reserve: reserves,
                net_base_asset_amount: 100 * AMM_RESERVE_PRECISION as i128,
                sqrt_k: reserves,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                base_spread: 5000,
                max_spread: 1000000,
                long_spread: 50000,
                short_spread: 50000,
                amm_jit_intensity: 100,
                ..AMM::default()
            },
            base_asset_amount_long: 100 * AMM_RESERVE_PRECISION as i128,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            initialized: true,
            ..Market::default_test()
        };
        market.amm.max_base_asset_reserve = u128::MAX;
        market.amm.min_base_asset_reserve = 0;

        let (new_ask_base_asset_reserve, new_ask_quote_asset_reserve) =
            crate::amm::calculate_spread_reserves(&market.amm, PositionDirection::Long).unwrap();
        let (new_bid_base_asset_reserve, new_bid_quote_asset_reserve) =
            crate::amm::calculate_spread_reserves(&market.amm, PositionDirection::Short).unwrap();
        market.amm.ask_base_asset_reserve = new_ask_base_asset_reserve;
        market.amm.bid_base_asset_reserve = new_bid_base_asset_reserve;
        market.amm.ask_quote_asset_reserve = new_ask_quote_asset_reserve;
        market.amm.bid_quote_asset_reserve = new_bid_quote_asset_reserve;

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

        // taker wants to go long (would improve balance)
        let auction_duration = 50;
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: 100 * BASE_PRECISION,
                ts: 0,
                slot: 0,
                auction_duration, // !! amm will bid before the ask spread price
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -100 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let auction_start_price =
            crate::math::auction::calculate_auction_start_price(&market, PositionDirection::Short)
                .unwrap();
        let auction_end_price = crate::math::auction::calculate_auction_end_price(
            &market,
            PositionDirection::Short,
            BASE_PRECISION,
        )
        .unwrap();
        taker.orders[0].auction_start_price = auction_start_price;
        taker.orders[0].auction_end_price = auction_end_price;
        println!("start stop {} {}", auction_start_price, auction_end_price);

        let mut filler = User::default();
        let fee_structure = get_fee_structure();
        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();
        let mut filler_stats = UserStats::default();

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        let (mut neg, mut pos, mut none) = (false, false, false);
        let mut prev_mm_fee = 0;
        let mut prev_net_baa = market.amm.net_base_asset_amount;
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
                crate::math::auction::calculate_auction_price(&taker.orders[0], slot).unwrap();
            let baa = market.amm.base_asset_amount_step_size * 4;

            let (mark, ask, bid) = {
                let market = market_map.get_ref(&0).unwrap();
                let mark = market.amm.mark_price().unwrap();
                let ask = market.amm.ask_price(mark).unwrap();
                let bid = market.amm.bid_price(mark).unwrap();
                (mark, ask, bid)
            };
            println!("mark: {} bid ask: {} {}", mark, bid, ask);

            let (_, _, _quote_asset_amount_surplus, _) =
                crate::controller::position::update_position_with_base_asset_amount(
                    baa / 2, // amm takes on half
                    PositionDirection::Short,
                    &mut market_map.get_ref_mut(&0).unwrap(),
                    &mut taker,
                    0,
                    mark,
                    now,
                    Some(auction_price),
                )
                .unwrap();

            let mut maker = User {
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Long,
                    base_asset_amount: baa,
                    ts: 0,
                    price: auction_price,
                    ..Order::default()
                }),
                positions: get_positions(MarketPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: baa as i128,
                    ..MarketPosition::default()
                }),
                ..User::default()
            };

            // fulfill with match
            fulfill_order(
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

            let market_after = market_map.get_ref(&0).unwrap();
            let quote_asset_amount_surplus = market_after.amm.total_mm_fee - prev_mm_fee;
            prev_mm_fee = market_after.amm.total_mm_fee;

            // imbalance decreases
            assert!(market_after.amm.net_base_asset_amount.abs() < prev_net_baa.abs());
            prev_net_baa = market_after.amm.net_base_asset_amount;

            println!("estim qas: {}", _quote_asset_amount_surplus);
            println!(
                "slot {} auction: {} surplus: {}",
                slot, auction_price, quote_asset_amount_surplus
            );

            assert_eq!(_quote_asset_amount_surplus, quote_asset_amount_surplus);

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
        assert!(none);

        println!("{} {} {}", neg, pos, none);
    }
}
