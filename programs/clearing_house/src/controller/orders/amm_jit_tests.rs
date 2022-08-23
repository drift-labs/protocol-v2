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
                amm_jit: true,
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
        // assert_eq!(taker_position.quote_asset_amount, -102335406);
        // assert_eq!(taker_position.quote_entry_amount, -102284264);
        // assert_eq!(taker_position.open_bids, 0);
        // assert_eq!(taker_position.open_orders, 0);
        // assert_eq!(taker_stats.fees.total_fee_paid, 51142);
        // assert_eq!(taker_stats.fees.total_referee_discount, 0);
        // assert_eq!(taker_stats.fees.total_token_discount, 0);
        assert_eq!(taker_stats.taker_volume_30d, 102284244);
        assert_eq!(taker.orders[0], Order::default());

        let maker_position = &maker.positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I128 / 2);
        assert_eq!(maker_position.quote_asset_amount, 50015000);
        assert_eq!(maker_position.quote_entry_amount, 50 * QUOTE_PRECISION_I128);
        assert_eq!(maker_position.open_orders, 0);
        assert_eq!(maker_stats.fees.total_fee_rebate, 15000);
        assert_eq!(maker_stats.maker_volume_30d, 50 * QUOTE_PRECISION_U64);
        // assert_eq!(maker.orders[0], Order::default());

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, 10000000000000);
        //inadvertantly got flipped position, todo improve decision/amount to unload based on fufillment criteria

        // assert_eq!(market_after.base_asset_amount_long, 10000000000000);
        // assert_eq!(market_after.base_asset_amount_short, -10000000000000);
        // assert_eq!(market_after.amm.quote_asset_amount_long, -102284264);
        // assert_eq!(market_after.amm.quote_asset_amount_short, 50000000);
        assert_eq!(market_after.amm.total_fee, 2064035); //paid toll to unload?
                                                         // assert_eq!(market_after.amm.total_fee_minus_distributions, 2064035);
                                                         // assert_eq!(market_after.amm.net_revenue_since_last_funding, 2064035);
        assert_eq!(filler_stats.filler_volume_30d, 102284244); // from 102284244, no filler reward for unload amount
                                                               // assert_eq!(filler.positions[0].quote_asset_amount, 5114);
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
                amm_jit: true,
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
                amm_jit: true,
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
        // assert_eq!(maker.orders[0], Order::default());

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, -2500000000000);
        //inadvertantly got flipped position, todo improve decision/amount to unload based on fufillment criteria

        let quote_asset_amount_surplus = market_after.amm.total_mm_fee - market.amm.total_mm_fee;

        assert!(quote_asset_amount_surplus > 0);
        assert_eq!(quote_asset_amount_surplus, 677570); // todo add negative test as well

        assert_eq!(market_after.amm.total_fee, 713847); //paid toll to unload?
        assert_eq!(market_after.amm.total_fee_minus_distributions, 713847);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 713847);
        assert_eq!(market_after.amm.total_mm_fee, 677570);
        assert_eq!(market_after.amm.total_exchange_fee, 36141);
        assert_eq!(market_after.amm.total_fee_withdrawn, 0);

        assert_eq!(filler_stats.filler_volume_30d, 97283221); // from 102284244, no filler reward for unload amount
                                                              // assert_eq!(filler.positions[0].quote_asset_amount, 5114);
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
                amm_jit: true,
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
        // assert_eq!(taker_position.quote_asset_amount, -102335406);
        // assert_eq!(taker_position.quote_entry_amount, -102284264);
        // assert_eq!(taker_position.open_bids, 0);
        // assert_eq!(taker_position.open_orders, 0);
        // assert_eq!(taker_stats.fees.total_fee_paid, 51142);
        // assert_eq!(taker_stats.fees.total_referee_discount, 0);
        // assert_eq!(taker_stats.fees.total_token_discount, 0);
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
        // assert_eq!(maker.orders[0], Order::default());

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.net_base_asset_amount, 2500000000000);

        // mm gains from trade
        let quote_asset_amount_surplus = market_after.amm.total_mm_fee - market.amm.total_mm_fee;

        assert!(quote_asset_amount_surplus > 0);
        assert_eq!(quote_asset_amount_surplus, 697892); // todo add negative test as well

        assert_eq!(market_after.amm.total_fee, 736645); //paid toll to unload?
        assert_eq!(market_after.amm.total_fee_minus_distributions, 736645);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, 736645);
        assert_eq!(market_after.amm.total_mm_fee, 697892);
        assert_eq!(market_after.amm.total_exchange_fee, 38892);
        assert_eq!(market_after.amm.total_fee_withdrawn, 0);

        assert_eq!(filler_stats.filler_volume_30d, 102784235); // from 102284244, no filler reward for unload amount
                                                               // assert_eq!(filler.positions[0].quote_asset_amount, 5114);
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
                amm_jit: true,
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
        // assert_eq!(taker_position.quote_asset_amount, -102335406);
        // assert_eq!(taker_position.quote_entry_amount, -102284264);
        // assert_eq!(taker_position.open_bids, 0);
        // assert_eq!(taker_position.open_orders, 0);
        // assert_eq!(taker_stats.fees.total_fee_paid, 51142);
        // assert_eq!(taker_stats.fees.total_referee_discount, 0);
        // assert_eq!(taker_stats.fees.total_token_discount, 0);
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

        assert_eq!(market_after.amm.total_fee, -21579653); //paid toll to unload?
        assert_eq!(market_after.amm.total_fee_minus_distributions, -21579653);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, -21579653);
        assert_eq!(market_after.amm.total_mm_fee, -21582278);
        assert_eq!(market_after.amm.total_exchange_fee, 2500);
        assert_eq!(market_after.amm.total_fee_withdrawn, 0);

        assert_eq!(filler_stats.filler_volume_30d, 7499999); // from 102284244, no filler reward for unload amount
                                                             // assert_eq!(filler.positions[0].quote_asset_amount, 5114);
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
                amm_jit: true,
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

        assert_eq!(market_after.amm.total_fee, -16517710); //paid toll to unload?
        assert_eq!(market_after.amm.total_fee_minus_distributions, -16517710);
        assert_eq!(market_after.amm.net_revenue_since_last_funding, -16517710);
        assert_eq!(market_after.amm.total_mm_fee, -16543210);
        assert_eq!(market_after.amm.total_exchange_fee, 20000);
        assert_eq!(market_after.amm.total_fee_withdrawn, 0);

        assert_eq!(filler_stats.filler_volume_30d, 89999984); // from 102284244, no filler reward for unload amount
                                                              // assert_eq!(filler.positions[0].quote_asset_amount, 5114);
    }
}
