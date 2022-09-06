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
pub mod delisting {
    use super::*;
    use crate::controller::orders::fill_order;

    use crate::math::margin::{
        calculate_margin_requirement_and_total_collateral, meets_initial_margin_requirement,
        MarginRequirementType,
    };
    use crate::state::events::{OrderAction, OrderActionExplanation};

    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, AMM_RESERVE_PRECISION_I128, BANK_CUMULATIVE_INTEREST_PRECISION,
        BANK_INTEREST_PRECISION, BANK_WEIGHT_PRECISION, BASE_PRECISION, BASE_PRECISION_I128,
        MARK_PRICE_PRECISION, PEG_PRECISION, QUOTE_PRECISION_I128, QUOTE_PRECISION_U64,
    };
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::BankMap;
    use crate::state::market::{Market, MarketStatus, PoolBalance, AMM};
    use crate::state::market_map::MarketMap;
    use crate::state::oracle::OracleSource;
    use crate::state::user::{OrderStatus, OrderType, User, UserBankBalance, UserStats};
    use crate::tests::utils::*;

    use crate::controller::orders::cancel_order;
    use crate::controller::pnl::settle_expired_position;
    use crate::controller::repeg::settle_expired_market;
    use crate::state::state::{
        OracleGuardRails, PriceDivergenceGuardRails, State, ValidityGuardRails,
    };
    use anchor_lang::prelude::Clock;
    use std::str::FromStr;

    // fn init_test_state() -> (&mut MarketMap, &mut OracleMap &mut BankMap, State, Clock, User, User) {
    //     let now = 0_i64;
    //     let slot = 0_u64;
    //     let clock = Clock {
    //         slot: 6893025720,
    //         epoch_start_timestamp: 1662065595 - 1000,
    //         epoch: 2424,
    //         leader_schedule_epoch: 1662065595 - 1,
    //         unix_timestamp: 1662065595,
    //     };

    //     let mut oracle_price = get_pyth_price(100, 10);
    //     let oracle_price_key =
    //         Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    //     let pyth_program = crate::ids::pyth_program::id();
    //     create_account_info!(
    //         oracle_price,
    //         &oracle_price_key,
    //         &pyth_program,
    //         oracle_account_info
    //     );
    //     let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot).unwrap();

    //     // net users are short
    //     let mut market = Market {
    //         amm: AMM {
    //             base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
    //             quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
    //             bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
    //             bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
    //             ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
    //             ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
    //             net_base_asset_amount: -((AMM_RESERVE_PRECISION * 800) as i128),
    //             sqrt_k: 100 * AMM_RESERVE_PRECISION,
    //             peg_multiplier: 100 * PEG_PRECISION,
    //             max_slippage_ratio: 50,
    //             max_base_asset_amount_ratio: 100,
    //             base_asset_amount_step_size: 10000000,
    //             oracle: oracle_price_key,
    //             amm_jit_intensity: 100,
    //             last_oracle_price_twap: (99 * MARK_PRICE_PRECISION) as i128,
    //             quote_asset_amount_long: (QUOTE_PRECISION_I128 * 1 * 200), // longs have -$1 cost basis
    //             quote_asset_amount_short: (QUOTE_PRECISION_I128 * 97 * 1000), // shorts have $97 cost basis
    //             total_fee_minus_distributions: 0,
    //             ..AMM::default()
    //         },
    //         open_interest: 2,
    //         base_asset_amount_long: (AMM_RESERVE_PRECISION * 200) as i128,
    //         base_asset_amount_short: -((AMM_RESERVE_PRECISION * 1000) as i128),
    //         margin_ratio_initial: 1000,
    //         margin_ratio_maintenance: 500,
    //         status: MarketStatus::Initialized,
    //         pnl_pool: PoolBalance {
    //             balance: (1000 * QUOTE_PRECISION_I128) as u128,
    //         },
    //         expiry_ts: clock.unix_timestamp - 10, // past expiry time

    //         ..Market::default_test()
    //     };
    //     market.amm.max_base_asset_reserve = u128::MAX;
    //     market.amm.min_base_asset_reserve = 0;

    //     create_anchor_account_info!(market, Market, market_account_info);
    //     let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

    //     let mut bank = Bank {
    //         bank_index: 0,
    //         oracle_source: OracleSource::QuoteAsset,
    //         cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
    //         cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
    //         decimals: 6,
    //         initial_asset_weight: BANK_WEIGHT_PRECISION,
    //         maintenance_asset_weight: BANK_WEIGHT_PRECISION,
    //         initial_liability_weight: BANK_WEIGHT_PRECISION,
    //         maintenance_liability_weight: BANK_WEIGHT_PRECISION,
    //         deposit_balance: 40000 * BANK_INTEREST_PRECISION,
    //         borrow_balance: 100 * BANK_INTEREST_PRECISION,
    //         ..Bank::default()
    //     };
    //     create_anchor_account_info!(bank, Bank, bank_account_info);
    //     let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

    //     // taker wants to go long (would improve balance)
    //     let mut longer = User {
    //         orders: get_orders(Order {
    //             market_index: 0,
    //             status: OrderStatus::Open,
    //             order_type: OrderType::Market,
    //             direction: PositionDirection::Long,
    //             base_asset_amount: BASE_PRECISION,
    //             ts: 0,
    //             slot: 0,
    //             auction_start_price: 0,
    //             auction_end_price: 100 * MARK_PRICE_PRECISION,
    //             auction_duration: 0,
    //             ..Order::default()
    //         }),
    //         positions: get_positions(MarketPosition {
    //             market_index: 0,
    //             open_orders: 1,
    //             open_bids: BASE_PRECISION_I128,
    //             base_asset_amount: (AMM_RESERVE_PRECISION_I128 * 200),
    //             quote_asset_amount: (QUOTE_PRECISION_I128 * 1 * 2000), //longs have -$1 cost basis,
    //             ..MarketPosition::default()
    //         }),
    //         bank_balances: get_bank_balances(UserBankBalance {
    //             bank_index: 0,
    //             balance_type: BankBalanceType::Deposit,
    //             balance: 20000 * BANK_INTEREST_PRECISION,
    //         }),
    //         ..User::default()
    //     };

    //     let mut shorter = User {
    //         orders: get_orders(Order {
    //             market_index: 0,
    //             post_only: true,
    //             status: OrderStatus::Open,
    //             order_type: OrderType::Limit,
    //             direction: PositionDirection::Short,
    //             base_asset_amount: BASE_PRECISION / 2,
    //             ts: 0,
    //             price: 100 * MARK_PRICE_PRECISION,
    //             ..Order::default()
    //         }),
    //         positions: get_positions(MarketPosition {
    //             market_index: 0,
    //             open_orders: 1,
    //             open_asks: -BASE_PRECISION_I128 / 2,
    //             base_asset_amount: -(AMM_RESERVE_PRECISION_I128 * 1000),
    //             quote_asset_amount: (QUOTE_PRECISION_I128 * 97 * 1000), //shorts have $20 cost basis,
    //             ..MarketPosition::default()
    //         }),
    //         bank_balances: get_bank_balances(UserBankBalance {
    //             bank_index: 0,
    //             balance_type: BankBalanceType::Deposit,
    //             balance: 20000 * BANK_INTEREST_PRECISION,
    //         }),
    //         ..User::default()
    //     };

    //     let mut filler = User::default();

    //     let fee_structure = get_fee_structure();

    //     let (taker_key, maker_key, filler_key) = get_user_keys();

    //     let mut taker_stats = UserStats::default();
    //     let mut maker_stats = UserStats::default();
    //     let mut filler_stats = UserStats::default();

    //     let state = State {
    //         oracle_guard_rails: OracleGuardRails {
    //             price_divergence: PriceDivergenceGuardRails {
    //                 mark_oracle_divergence_numerator: 1,
    //                 mark_oracle_divergence_denominator: 10,
    //             },
    //             validity: ValidityGuardRails {
    //                 slots_before_stale: 10,
    //                 confidence_interval_max_size: 1000,
    //                 too_volatile_ratio: 5,
    //             },
    //             use_for_liquidations: true,
    //         },
    //         ..State::default()
    //     };

    //     // expiry time
    //     // assert_eq!(market.expiry_ts < clock.unix_timestamp, true);
    //     // assert_eq!(market.status, MarketStatus::Initialized);
    //     // assert_eq!(market.settlement_price, 0);

    //     (
    //         market_map, oracle_map, bank_map, state, clock, longer, shorter,
    //     )
    // }

    #[test]
    fn failed_attempt_to_close_healthy_market() {
        let now = 0_i64;
        let slot = 0_u64;
        let clock = Clock {
            slot: 6893025720,
            epoch_start_timestamp: 1662065595 - 1000,
            epoch: 2424,
            leader_schedule_epoch: 1662065595 - 1,
            unix_timestamp: 1662065595,
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
            status: MarketStatus::Initialized,
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

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        // attempt to delist healthy market
        assert_eq!(market.expiry_ts, 0);
        assert!(
            settle_expired_market(0, &market_map, &mut oracle_map, &bank_map, &state, &clock,)
                .is_err()
        );

        market.expiry_ts = clock.unix_timestamp + 100;
        assert_eq!(clock.unix_timestamp, 1662065595);

        // attempt to delist too early
        assert!(
            settle_expired_market(0, &market_map, &mut oracle_map, &bank_map, &state, &clock,)
                .is_err()
        );
    }

    #[test]
    fn delist_market_with_0_balance_long_at_target() {
        let now = 0_i64;
        let slot = 0_u64;
        let clock = Clock {
            slot: 6893025720,
            epoch_start_timestamp: 1662065595 - 1000,
            epoch: 2424,
            leader_schedule_epoch: 1662065595 - 1,
            unix_timestamp: 1662065595,
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
                last_oracle_price_twap: (99 * MARK_PRICE_PRECISION) as i128,
                quote_asset_amount_long: -(QUOTE_PRECISION_I128 * 50), //longs have $100 cost basis
                quote_asset_amount_short: 0,                           // no shorts
                ..AMM::default()
            },
            base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            expiry_ts: clock.unix_timestamp - 10, // past expiry time

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

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        // expiry time
        assert_eq!(market.expiry_ts < clock.unix_timestamp, true);
        assert_eq!(market.status, MarketStatus::Initialized);
        assert_eq!(market.settlement_price, 0);

        // put in settlement mode
        settle_expired_market(0, &market_map, &mut oracle_map, &bank_map, &state, &clock).unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.settlement_price > 0, true);
        assert_eq!(market.settlement_price, 989999999999);
        assert_eq!(market.status, MarketStatus::Settlement);
        drop(market);
    }

    #[test]
    fn delist_market_with_0_balance_long_at_best_effort() {
        let now = 0_i64;
        let slot = 0_u64;
        let clock = Clock {
            slot: 6893025720,
            epoch_start_timestamp: 1662065595 - 1000,
            epoch: 2424,
            leader_schedule_epoch: 1662065595 - 1,
            unix_timestamp: 1662065595,
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
                last_oracle_price_twap: (99 * MARK_PRICE_PRECISION) as i128,
                quote_asset_amount_long: -(QUOTE_PRECISION_I128 * 10), //longs have $20 cost basis
                quote_asset_amount_short: 0,                           // no shorts
                ..AMM::default()
            },
            base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            expiry_ts: clock.unix_timestamp - 10, // past expiry time

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

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        // expiry time
        assert_eq!(market.expiry_ts < clock.unix_timestamp, true);
        assert_eq!(market.status, MarketStatus::Initialized);
        assert_eq!(market.settlement_price, 0);

        // put in settlement mode
        settle_expired_market(0, &market_map, &mut oracle_map, &bank_map, &state, &clock).unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.settlement_price > 0, true);
        assert_eq!(
            market.settlement_price < market.amm.last_oracle_price_twap,
            true
        );
        assert_eq!(market.settlement_price, 199999999999); // best can do :/
        assert_eq!(market.status, MarketStatus::Settlement);
        drop(market);
    }

    #[test]
    fn delist_market_with_neg_balance_long_at_best_effort() {
        let now = 0_i64;
        let slot = 0_u64;
        let clock = Clock {
            slot: 6893025720,
            epoch_start_timestamp: 1662065595 - 1000,
            epoch: 2424,
            leader_schedule_epoch: 1662065595 - 1,
            unix_timestamp: 1662065595,
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
                last_oracle_price_twap: (99 * MARK_PRICE_PRECISION) as i128,
                total_fee_minus_distributions: -(100000 * QUOTE_PRECISION_I128), // down $100k
                quote_asset_amount_long: -(QUOTE_PRECISION_I128 * 10), //longs have $20 cost basis
                quote_asset_amount_short: 0,                           // no shorts
                ..AMM::default()
            },
            base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            expiry_ts: clock.unix_timestamp - 10, // past expiry time

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

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        // expiry time
        assert_eq!(market.expiry_ts < clock.unix_timestamp, true);
        assert_eq!(market.status, MarketStatus::Initialized);
        assert_eq!(market.settlement_price, 0);

        // put in settlement mode
        settle_expired_market(0, &market_map, &mut oracle_map, &bank_map, &state, &clock).unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.settlement_price > 0, true);
        assert_eq!(
            market.settlement_price < market.amm.last_oracle_price_twap,
            true
        );
        assert_eq!(market.settlement_price, 199999999999); // best can do :/
        assert_eq!(market.status, MarketStatus::Settlement);
        drop(market);
    }

    #[test]
    fn delist_market_with_neg_balance_short_at_target() {
        let slot = 0_u64;
        let clock = Clock {
            slot: 6893025720,
            epoch_start_timestamp: 1662065595 - 1000,
            epoch: 2424,
            leader_schedule_epoch: 1662065595 - 1,
            unix_timestamp: 1662065595,
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
                last_oracle_price_twap: (99 * MARK_PRICE_PRECISION) as i128,
                total_fee_minus_distributions: -(100000 * QUOTE_PRECISION_I128), // down $100k
                quote_asset_amount_long: 0,
                quote_asset_amount_short: (QUOTE_PRECISION_I128 * 10), //shorts have $20 cost basis
                ..AMM::default()
            },
            base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            expiry_ts: clock.unix_timestamp - 10, // past expiry time

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

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        // expiry time
        assert_eq!(market.expiry_ts < clock.unix_timestamp, true);
        assert_eq!(market.status, MarketStatus::Initialized);
        assert_eq!(market.settlement_price, 0);

        // put in settlement mode
        settle_expired_market(0, &market_map, &mut oracle_map, &bank_map, &state, &clock).unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.settlement_price > 0, true);
        assert_eq!(market.settlement_price, 990000000001); // target
        assert_eq!(market.status, MarketStatus::Settlement);
        drop(market);
    }

    #[test]
    fn delist_market_with_1000_balance_long_at_target() {
        let now = 0_i64;
        let slot = 0_u64;
        let clock = Clock {
            slot: 6893025720,
            epoch_start_timestamp: 1662065595 - 1000,
            epoch: 2424,
            leader_schedule_epoch: 1662065595 - 1,
            unix_timestamp: 1662065595,
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
                last_oracle_price_twap: (99 * MARK_PRICE_PRECISION) as i128,
                quote_asset_amount_long: -(QUOTE_PRECISION_I128 * 10), //longs have $20 cost basis
                quote_asset_amount_short: 0,                           // no shorts
                total_fee_minus_distributions: 0,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            pnl_pool: PoolBalance {
                balance: (1000 * QUOTE_PRECISION_I128) as u128,
            },
            expiry_ts: clock.unix_timestamp - 10, // past expiry time

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
            initial_liability_weight: BANK_WEIGHT_PRECISION,
            maintenance_liability_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 10000 * BANK_INTEREST_PRECISION,
            borrow_balance: 100 * BANK_INTEREST_PRECISION,
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
                base_asset_amount: (AMM_RESERVE_PRECISION_I128 / 2),
                quote_asset_amount: -(QUOTE_PRECISION_I128 * 10),
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

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        // expiry time
        assert_eq!(market.expiry_ts < clock.unix_timestamp, true);
        assert_eq!(market.status, MarketStatus::Initialized);
        assert_eq!(market.settlement_price, 0);

        let (margin_requirement, total_collateral) =
            calculate_margin_requirement_and_total_collateral(
                &taker,
                &market_map,
                MarginRequirementType::Maintenance,
                &bank_map,
                &mut oracle_map,
            )
            .unwrap();

        assert_eq!(total_collateral, 100000000);
        assert_eq!(margin_requirement, 7500000);

        // put in settlement mode
        settle_expired_market(0, &market_map, &mut oracle_map, &bank_map, &state, &clock).unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.settlement_price > 0, true);
        assert_eq!(market.settlement_price, 989999999999);
        assert_eq!(market.status, MarketStatus::Settlement);
        drop(market);

        let (margin_requirement, total_collateral) =
            calculate_margin_requirement_and_total_collateral(
                &taker,
                &market_map,
                MarginRequirementType::Maintenance,
                &bank_map,
                &mut oracle_map,
            )
            .unwrap();

        assert_eq!(total_collateral, 100000000);
        assert_eq!(margin_requirement, 7424999);

        // open orders fails
        assert_eq!(
            settle_expired_position(
                0,
                &mut taker,
                &taker_key,
                &market_map,
                &bank_map,
                &mut oracle_map,
                clock.unix_timestamp,
                &state.fee_structure
            )
            .is_err(),
            true
        );

        cancel_order(
            0,
            &mut taker,
            &taker_key,
            &market_map,
            &mut oracle_map,
            clock.unix_timestamp,
            clock.slot,
            OrderActionExplanation::None,
            None,
            0,
            true,
        )
        .unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.pnl_pool.balance, 1000000000);
        assert_eq!(taker.bank_balances[0].balance, 100000000);
        assert_eq!(taker.positions[0].quote_asset_amount, -10000000);
        drop(market);

        settle_expired_position(
            0,
            &mut taker,
            &taker_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            clock.unix_timestamp,
            &state.fee_structure,
        )
        .unwrap();

        assert_eq!(taker.bank_balances[0].balance > 100000000, true);
        assert_eq!(taker.bank_balances[0].balance, 139450500);

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.pnl_pool.balance, 960549499);
        assert_eq!(139450500 - 100000000, 39450500);
        assert_eq!(1000000000 - 960549499, 39450500 + 1);
        drop(market);

        assert_eq!(taker.positions[0].open_orders, 0);
        assert_eq!(taker.positions[0].base_asset_amount, 0);
        assert_eq!(taker.positions[0].quote_asset_amount, 0);
        assert_eq!(taker.positions[0].quote_entry_amount, 0);
    }

    #[test]
    fn delist_market_with_1000_balance_long_at_target_price_w_positive_quote_long() {
        let now = 0_i64;
        let slot = 0_u64;
        let clock = Clock {
            slot: 6893025720,
            epoch_start_timestamp: 1662065595 - 1000,
            epoch: 2424,
            leader_schedule_epoch: 1662065595 - 1,
            unix_timestamp: 1662065595,
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
                last_oracle_price_twap: (99 * MARK_PRICE_PRECISION) as i128,
                quote_asset_amount_long: (QUOTE_PRECISION_I128 * 10), //longs have -$20 cost basis
                quote_asset_amount_short: 0,                          // no shorts
                total_fee_minus_distributions: 0,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            pnl_pool: PoolBalance {
                balance: (1000 * QUOTE_PRECISION_I128) as u128,
            },
            expiry_ts: clock.unix_timestamp - 10, // past expiry time

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
            initial_liability_weight: BANK_WEIGHT_PRECISION,
            maintenance_liability_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 10000 * BANK_INTEREST_PRECISION,
            borrow_balance: 100 * BANK_INTEREST_PRECISION,
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
                base_asset_amount: (AMM_RESERVE_PRECISION_I128 / 2),
                quote_asset_amount: (QUOTE_PRECISION_I128 * 10),
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

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        // expiry time
        assert_eq!(market.expiry_ts < clock.unix_timestamp, true);
        assert_eq!(market.status, MarketStatus::Initialized);
        assert_eq!(market.settlement_price, 0);

        let (margin_requirement, total_collateral) =
            calculate_margin_requirement_and_total_collateral(
                &taker,
                &market_map,
                MarginRequirementType::Maintenance,
                &bank_map,
                &mut oracle_map,
            )
            .unwrap();

        assert_eq!(total_collateral, 100000000);
        assert_eq!(margin_requirement, 7500000);

        // put in settlement mode
        settle_expired_market(0, &market_map, &mut oracle_map, &bank_map, &state, &clock).unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.settlement_price > 0, true);
        assert_eq!(market.settlement_price, 989999999999);
        assert_eq!(market.status, MarketStatus::Settlement);
        drop(market);

        let (margin_requirement, total_collateral) =
            calculate_margin_requirement_and_total_collateral(
                &taker,
                &market_map,
                MarginRequirementType::Maintenance,
                &bank_map,
                &mut oracle_map,
            )
            .unwrap();

        assert_eq!(total_collateral, 100000000);
        assert_eq!(margin_requirement, 7424999); // settlement in margin now

        // open orders fails
        assert_eq!(
            settle_expired_position(
                0,
                &mut taker,
                &taker_key,
                &market_map,
                &bank_map,
                &mut oracle_map,
                clock.unix_timestamp,
                &state.fee_structure
            )
            .is_err(),
            true
        );

        cancel_order(
            0,
            &mut taker,
            &taker_key,
            &market_map,
            &mut oracle_map,
            clock.unix_timestamp,
            clock.slot,
            OrderActionExplanation::None,
            None,
            0,
            true,
        )
        .unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.pnl_pool.balance, 1000000000);
        assert_eq!(taker.bank_balances[0].balance, 100000000);
        assert_eq!(taker.positions[0].quote_asset_amount, 10000000);
        drop(market);

        settle_expired_position(
            0,
            &mut taker,
            &taker_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            clock.unix_timestamp,
            &state.fee_structure,
        )
        .unwrap();

        assert_eq!(taker.bank_balances[0].balance > 100000000, true);
        assert_eq!(taker.bank_balances[0].balance, 159450500);

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.pnl_pool.balance, 940549499);
        drop(market);

        assert_eq!(taker.positions[0].open_orders, 0);
        assert_eq!(taker.positions[0].base_asset_amount, 0);
        assert_eq!(taker.positions[0].quote_asset_amount, 0);
        assert_eq!(taker.positions[0].quote_entry_amount, 0);
    }

    #[test]
    fn delist_market_with_1000_balance_long_negative_settlement_price() {
        // longs have negative cost basis and are up big
        // so settlement price has to be negative

        let now = 0_i64;
        let slot = 0_u64;
        let clock = Clock {
            slot: 6893025720,
            epoch_start_timestamp: 1662065595 - 1000,
            epoch: 2424,
            leader_schedule_epoch: 1662065595 - 1,
            unix_timestamp: 1662065595,
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
                net_base_asset_amount: (AMM_RESERVE_PRECISION * 2000) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                last_oracle_price_twap: (99 * MARK_PRICE_PRECISION) as i128,
                quote_asset_amount_long: (QUOTE_PRECISION_I128 * 20 * 2000), //longs have -$20 cost basis
                quote_asset_amount_short: 0,                                 // no shorts
                total_fee_minus_distributions: 0,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_long: (AMM_RESERVE_PRECISION * 2000) as i128,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            pnl_pool: PoolBalance {
                balance: (1000 * QUOTE_PRECISION_I128) as u128,
            },
            expiry_ts: clock.unix_timestamp - 10, // past expiry time

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
            initial_liability_weight: BANK_WEIGHT_PRECISION,
            maintenance_liability_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 10000 * BANK_INTEREST_PRECISION,
            borrow_balance: 100 * BANK_INTEREST_PRECISION,
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
                base_asset_amount: (AMM_RESERVE_PRECISION_I128 * 2000),
                quote_asset_amount: (QUOTE_PRECISION_I128 * 20 * 2000), //longs have -$20 cost basis,
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

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        // expiry time
        assert_eq!(market.expiry_ts < clock.unix_timestamp, true);
        assert_eq!(market.status, MarketStatus::Initialized);
        assert_eq!(market.settlement_price, 0);

        // put in settlement mode
        settle_expired_market(0, &market_map, &mut oracle_map, &bank_map, &state, &clock).unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.settlement_price != 0, true);
        assert_eq!(market.settlement_price, -195000000001);
        assert_eq!(market.status, MarketStatus::Settlement);
        drop(market);

        let (margin_requirement, total_collateral) =
            calculate_margin_requirement_and_total_collateral(
                &taker,
                &market_map,
                MarginRequirementType::Maintenance,
                &bank_map,
                &mut oracle_map,
            )
            .unwrap();

        assert_eq!(total_collateral, 100000000);
        assert_eq!(margin_requirement, 0);

        // open orders fails
        assert_eq!(
            settle_expired_position(
                0,
                &mut taker,
                &taker_key,
                &market_map,
                &bank_map,
                &mut oracle_map,
                clock.unix_timestamp,
                &state.fee_structure
            )
            .is_err(),
            true
        );

        cancel_order(
            0,
            &mut taker,
            &taker_key,
            &market_map,
            &mut oracle_map,
            clock.unix_timestamp,
            clock.slot,
            OrderActionExplanation::None,
            None,
            0,
            true,
        )
        .unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.pnl_pool.balance, 1000000000);
        assert_eq!(taker.bank_balances[0].balance, 100000000);
        assert_eq!(taker.positions[0].quote_asset_amount, 40000000000);
        drop(market);

        settle_expired_position(
            0,
            &mut taker,
            &taker_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            clock.unix_timestamp,
            &state.fee_structure,
        )
        .unwrap();

        assert_eq!(taker.bank_balances[0].balance > 100000000, true);

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.pnl_pool.balance, 38999999); // no settle fee since base_asse_value=0 (since price is negative)
        assert_eq!(market.amm.fee_pool.balance, 0);
        drop(market);

        assert_eq!(taker.positions[0].open_orders, 0);
        assert_eq!(taker.positions[0].base_asset_amount, 0);
        assert_eq!(taker.positions[0].quote_asset_amount, 0);
        assert_eq!(taker.positions[0].quote_entry_amount, 0);
    }

    #[test]
    fn delist_market_with_1000_balance_shorts_owe_longs_0() {
        let now = 0_i64;
        let slot = 0_u64;
        let clock = Clock {
            slot: 6893025720,
            epoch_start_timestamp: 1662065595 - 1000,
            epoch: 2424,
            leader_schedule_epoch: 1662065595 - 1,
            unix_timestamp: 1662065595,
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
                net_base_asset_amount: (AMM_RESERVE_PRECISION * 1000) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                last_oracle_price_twap: (99 * MARK_PRICE_PRECISION) as i128,
                quote_asset_amount_long: -(QUOTE_PRECISION_I128 * 20 * 2000), // longs have $20 cost basis
                quote_asset_amount_short: (QUOTE_PRECISION_I128 * 20 * 1000), // shorts have $20 cost basis
                total_fee_minus_distributions: 0,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_long: (AMM_RESERVE_PRECISION * 2000) as i128,
            base_asset_amount_short: -((AMM_RESERVE_PRECISION * 1000) as i128),
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            pnl_pool: PoolBalance {
                balance: (1000 * QUOTE_PRECISION_I128) as u128,
            },
            expiry_ts: clock.unix_timestamp - 10, // past expiry time

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
            initial_liability_weight: BANK_WEIGHT_PRECISION,
            maintenance_liability_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 300000 * BANK_INTEREST_PRECISION,
            borrow_balance: 100 * BANK_INTEREST_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        // taker wants to go long (would improve balance)
        let mut longer = User {
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
                base_asset_amount: (AMM_RESERVE_PRECISION_I128 * 2000),
                quote_asset_amount: -(QUOTE_PRECISION_I128 * 20 * 2000), //longs have $20 cost basis,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 20000 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let mut shorter = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                status: OrderStatus::Open,
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
                base_asset_amount: -(AMM_RESERVE_PRECISION_I128 * 1000),
                quote_asset_amount: (QUOTE_PRECISION_I128 * 20 * 1000), //shorts have $20 cost basis,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 200000 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let mut filler = User::default();

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();
        let mut filler_stats = UserStats::default();

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        // expiry time
        assert_eq!(market.expiry_ts < clock.unix_timestamp, true);
        assert_eq!(market.status, MarketStatus::Initialized);
        assert_eq!(market.settlement_price, 0);

        let (margin_requirement, total_collateral) =
            calculate_margin_requirement_and_total_collateral(
                &longer,
                &market_map,
                MarginRequirementType::Maintenance,
                &bank_map,
                &mut oracle_map,
            )
            .unwrap();

        assert_eq!(total_collateral, 20000000000);
        assert_eq!(margin_requirement, 10005000000);

        // put in settlement mode
        settle_expired_market(0, &market_map, &mut oracle_map, &bank_map, &state, &clock).unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.settlement_price != 0, true);
        assert_eq!(market.settlement_price, 209999999999);
        assert_eq!(market.status, MarketStatus::Settlement);
        drop(market);

        // do short close
        {
            assert_eq!(shorter.orders[0].order_id, 0);
            assert_eq!(shorter.orders[0].status, OrderStatus::Open);
            assert_eq!(shorter.orders[0].base_asset_amount, 5000000000000);

            cancel_order(
                0,
                &mut shorter,
                &maker_key,
                &market_map,
                &mut oracle_map,
                clock.unix_timestamp,
                clock.slot,
                OrderActionExplanation::None,
                None,
                0,
                true,
            )
            .unwrap();

            let mut market = market_map.get_ref_mut(&0).unwrap();
            assert_eq!(market.pnl_pool.balance, 1000000000);

            let orig_short_balance = shorter.bank_balances[0].balance;

            assert_eq!(orig_short_balance, 200000000000);
            assert_eq!(shorter.positions[0].base_asset_amount, -10000000000000000);
            assert_eq!(shorter.positions[0].quote_asset_amount, 20000000000);
            drop(market);

            settle_expired_position(
                0,
                &mut shorter,
                &maker_key,
                &market_map,
                &bank_map,
                &mut oracle_map,
                clock.unix_timestamp,
                &state.fee_structure,
            )
            .unwrap();

            // shorts lose
            assert_eq!(shorter.bank_balances[0].balance < orig_short_balance, true);
            assert_eq!(shorter.bank_balances[0].balance, 198979000001);

            let shorter_loss = orig_short_balance - shorter.bank_balances[0].balance;
            assert_eq!(shorter_loss, 1_020_999_999); //$1020 loss

            let mut market = market_map.get_ref_mut(&0).unwrap();
            assert_eq!(market.pnl_pool.balance, 2020999998); //$2020
            assert_eq!(market.amm.fee_pool.balance, 0);
            drop(market);

            assert_eq!(shorter.positions[0].open_orders, 0);
            assert_eq!(shorter.positions[0].base_asset_amount, 0);
            assert_eq!(shorter.positions[0].quote_asset_amount, 0);
            assert_eq!(shorter.positions[0].quote_entry_amount, 0);
        }

        let (margin_requirement, total_collateral) =
            calculate_margin_requirement_and_total_collateral(
                &longer,
                &market_map,
                MarginRequirementType::Maintenance,
                &bank_map,
                &mut oracle_map,
            )
            .unwrap();

        assert_eq!(total_collateral, 20000000000);
        assert_eq!(margin_requirement, 2101049999);

        // open orders fails
        assert_eq!(
            settle_expired_position(
                0,
                &mut longer,
                &taker_key,
                &market_map,
                &bank_map,
                &mut oracle_map,
                clock.unix_timestamp,
                &state.fee_structure
            )
            .is_err(),
            true
        );

        cancel_order(
            0,
            &mut longer,
            &taker_key,
            &market_map,
            &mut oracle_map,
            clock.unix_timestamp,
            clock.slot,
            OrderActionExplanation::None,
            None,
            0,
            true,
        )
        .unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.pnl_pool.balance, 2020999998);
        assert_eq!(longer.bank_balances[0].balance, 20000000000);
        assert_eq!(longer.positions[0].quote_asset_amount, -40000000000);
        drop(market);

        settle_expired_position(
            0,
            &mut longer,
            &taker_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            clock.unix_timestamp,
            &state.fee_structure,
        )
        .unwrap();

        assert_eq!(longer.bank_balances[0].balance > 100000000, true);
        assert_eq!(longer.bank_balances[0].balance, 21958000000);

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.pnl_pool.balance, 62_999_997); //fee from settling
        assert_eq!(market.amm.fee_pool.balance, 0);
        drop(market);

        assert_eq!(longer.positions[0].open_orders, 0);
        assert_eq!(longer.positions[0].base_asset_amount, 0);
        assert_eq!(longer.positions[0].quote_asset_amount, 0);
        assert_eq!(longer.positions[0].quote_entry_amount, 0);
    }

    #[test]
    fn delist_market_with_1000_balance_shorts_owe_longs_long_close_first() {
        let now = 0_i64;
        let slot = 0_u64;
        let clock = Clock {
            slot: 6893025720,
            epoch_start_timestamp: 1662065595 - 1000,
            epoch: 2424,
            leader_schedule_epoch: 1662065595 - 1,
            unix_timestamp: 1662065595,
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
                net_base_asset_amount: -((AMM_RESERVE_PRECISION * 800) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                last_oracle_price_twap: (99 * MARK_PRICE_PRECISION) as i128,
                quote_asset_amount_long: (QUOTE_PRECISION_I128 * 1 * 200), // longs have -$1 cost basis
                quote_asset_amount_short: (QUOTE_PRECISION_I128 * 97 * 1000), // shorts have $97 cost basis
                total_fee_minus_distributions: 0,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_long: (AMM_RESERVE_PRECISION * 200) as i128,
            base_asset_amount_short: -((AMM_RESERVE_PRECISION * 1000) as i128),
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            pnl_pool: PoolBalance {
                balance: (1000 * QUOTE_PRECISION_I128) as u128,
            },
            expiry_ts: clock.unix_timestamp - 10, // past expiry time

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
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            initial_liability_weight: BANK_WEIGHT_PRECISION,
            maintenance_liability_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 10000 * BANK_INTEREST_PRECISION,
            borrow_balance: 100 * BANK_INTEREST_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        // taker wants to go long (would improve balance)
        let mut longer = User {
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
                base_asset_amount: (AMM_RESERVE_PRECISION_I128 * 200),
                quote_asset_amount: (QUOTE_PRECISION_I128 * 1 * 2000), //longs have -$1 cost basis,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 20000 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let mut shorter = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                status: OrderStatus::Open,
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
                base_asset_amount: -(AMM_RESERVE_PRECISION_I128 * 1000),
                quote_asset_amount: (QUOTE_PRECISION_I128 * 97 * 1000), //shorts have $20 cost basis,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 20000 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let mut filler = User::default();

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();
        let mut filler_stats = UserStats::default();

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        // expiry time
        assert_eq!(market.expiry_ts < clock.unix_timestamp, true);
        assert_eq!(market.status, MarketStatus::Initialized);
        assert_eq!(market.settlement_price, 0);

        let (margin_requirement, total_collateral) =
            calculate_margin_requirement_and_total_collateral(
                &longer,
                &market_map,
                MarginRequirementType::Maintenance,
                &bank_map,
                &mut oracle_map,
            )
            .unwrap();

        assert_eq!(total_collateral, 20000000000);
        assert_eq!(margin_requirement, 1005000000);

        // put in settlement mode
        settle_expired_market(0, &market_map, &mut oracle_map, &bank_map, &state, &clock).unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.settlement_price != 0, true);
        assert_eq!(market.settlement_price, 1202500000001); //$120.25 (vs $100)
        assert_eq!(market.status, MarketStatus::Settlement);
        drop(market);

        // try long close
        {
            let (margin_requirement, total_collateral) =
                calculate_margin_requirement_and_total_collateral(
                    &longer,
                    &market_map,
                    MarginRequirementType::Maintenance,
                    &bank_map,
                    &mut oracle_map,
                )
                .unwrap();

            assert_eq!(total_collateral, 20000000000);
            assert_eq!(margin_requirement, 1208512500);

            // open orders fails
            assert_eq!(
                settle_expired_position(
                    0,
                    &mut longer,
                    &taker_key,
                    &market_map,
                    &bank_map,
                    &mut oracle_map,
                    clock.unix_timestamp,
                    &state.fee_structure
                )
                .is_err(),
                true
            );

            cancel_order(
                0,
                &mut longer,
                &taker_key,
                &market_map,
                &mut oracle_map,
                clock.unix_timestamp,
                clock.slot,
                OrderActionExplanation::None,
                None,
                0,
                true,
            )
            .unwrap();

            let mut market = market_map.get_ref_mut(&0).unwrap();
            assert_eq!(market.pnl_pool.balance, 1000000000);
            assert_eq!(longer.bank_balances[0].balance, 20000000000);
            assert_eq!(longer.positions[0].quote_asset_amount, 2000000000);
            let longer_balance_before = longer.bank_balances[0].balance;
            drop(market);

            // not enough pnl pool
            assert_eq!(
                settle_expired_position(
                    0,
                    &mut longer,
                    &taker_key,
                    &market_map,
                    &bank_map,
                    &mut oracle_map,
                    clock.unix_timestamp,
                    &state.fee_structure
                )
                .is_err(),
                true
            );

            assert_eq!(
                longer.bank_balances[0].balance == longer_balance_before,
                true
            );

            let mut market = market_map.get_ref_mut(&0).unwrap();
            assert_eq!(market.pnl_pool.balance, 0);
            assert_eq!(market.amm.fee_pool.balance, 0);
            drop(market);

            //unchanged
            assert_eq!(longer.positions[0].open_orders, 0);
            assert_eq!(longer.positions[0].base_asset_amount, 2000000000000000);
            assert_eq!(longer.positions[0].quote_asset_amount, 2000000000);
            assert_eq!(longer.positions[0].quote_entry_amount, 0); //doesnt matter
        }

        // do short close
        {
            assert_eq!(shorter.orders[0].order_id, 0);
            assert_eq!(shorter.orders[0].status, OrderStatus::Open);
            assert_eq!(shorter.orders[0].base_asset_amount, 5000000000000);

            cancel_order(
                0,
                &mut shorter,
                &maker_key,
                &market_map,
                &mut oracle_map,
                clock.unix_timestamp,
                clock.slot,
                OrderActionExplanation::None,
                None,
                0,
                true,
            )
            .unwrap();

            let mut market = market_map.get_ref_mut(&0).unwrap();
            assert_eq!(market.pnl_pool.balance, 0);

            let orig_short_balance = shorter.bank_balances[0].balance;

            assert_eq!(orig_short_balance, 20000000000);
            assert_eq!(shorter.positions[0].base_asset_amount, -10000000000000000);
            assert_eq!(shorter.positions[0].quote_asset_amount, 97000000000);
            drop(market);

            settle_expired_position(
                0,
                &mut shorter,
                &maker_key,
                &market_map,
                &bank_map,
                &mut oracle_map,
                clock.unix_timestamp,
                &state.fee_structure,
            )
            .unwrap();

            assert_eq!(shorter.bank_balances[0].balance > 100000000, true);
            assert_eq!(shorter.bank_balances[0].balance, 3370250001);

            let shorter_loss = orig_short_balance - shorter.bank_balances[0].balance;
            assert_eq!(shorter_loss, 16_629_749_999); //$16629 loss

            let mut market = market_map.get_ref_mut(&0).unwrap();
            assert_eq!(market.pnl_pool.balance, 23370250000); //$23370
            assert_eq!(market.amm.fee_pool.balance, 0);
            drop(market);

            assert_eq!(shorter.positions[0].open_orders, 0);
            assert_eq!(shorter.positions[0].base_asset_amount, 0);
            assert_eq!(shorter.positions[0].quote_asset_amount, 0);
            assert_eq!(shorter.positions[0].quote_entry_amount, 0);
        }
    }

    #[test]
    fn delist_market_with_1000_balance_shorts_owe_longs_short_close_first() {
        let now = 0_i64;
        let slot = 0_u64;
        let clock = Clock {
            slot: 6893025720,
            epoch_start_timestamp: 1662065595 - 1000,
            epoch: 2424,
            leader_schedule_epoch: 1662065595 - 1,
            unix_timestamp: 1662065595,
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
                net_base_asset_amount: -((AMM_RESERVE_PRECISION * 800) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                last_oracle_price_twap: (99 * MARK_PRICE_PRECISION) as i128,
                quote_asset_amount_long: (QUOTE_PRECISION_I128 * 1 * 200), // longs have -$1 cost basis
                quote_asset_amount_short: (QUOTE_PRECISION_I128 * 97 * 1000), // shorts have $97 cost basis
                total_fee_minus_distributions: 0,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_long: (AMM_RESERVE_PRECISION * 200) as i128,
            base_asset_amount_short: -((AMM_RESERVE_PRECISION * 1000) as i128),
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            pnl_pool: PoolBalance {
                balance: (1000 * QUOTE_PRECISION_I128) as u128,
            },
            expiry_ts: clock.unix_timestamp - 10, // past expiry time

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
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            initial_liability_weight: BANK_WEIGHT_PRECISION,
            maintenance_liability_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 40000 * BANK_INTEREST_PRECISION,
            borrow_balance: 100 * BANK_INTEREST_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        // taker wants to go long (would improve balance)
        let mut longer = User {
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
                base_asset_amount: (AMM_RESERVE_PRECISION_I128 * 200),
                quote_asset_amount: (QUOTE_PRECISION_I128 * 1 * 200), //longs have -$1 cost basis,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 20000 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let mut shorter = User {
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                status: OrderStatus::Open,
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
                base_asset_amount: -(AMM_RESERVE_PRECISION_I128 * 1000),
                quote_asset_amount: (QUOTE_PRECISION_I128 * 97 * 1000), //shorts have $20 cost basis,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 20000 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let mut filler = User::default();

        let fee_structure = get_fee_structure();

        let (taker_key, maker_key, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();
        let mut maker_stats = UserStats::default();
        let mut filler_stats = UserStats::default();

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        let (margin_requirement, total_collateral) =
            calculate_margin_requirement_and_total_collateral(
                &longer,
                &market_map,
                MarginRequirementType::Maintenance,
                &bank_map,
                &mut oracle_map,
            )
            .unwrap();

        assert_eq!(total_collateral, 20000000000);
        assert_eq!(margin_requirement, 1005000000);

        // put in settlement mode
        settle_expired_market(0, &market_map, &mut oracle_map, &bank_map, &state, &clock).unwrap();

        let mut market = market_map.get_ref_mut(&0).unwrap();
        assert_eq!(market.settlement_price != 0, true);
        assert_eq!(market.settlement_price, 1202500000001); //$120.25 (vs $100)
        assert_eq!(market.status, MarketStatus::Settlement);
        drop(market);

        // do short close
        {
            assert_eq!(shorter.orders[0].order_id, 0);
            assert_eq!(shorter.orders[0].status, OrderStatus::Open);
            assert_eq!(shorter.orders[0].base_asset_amount, 5000000000000);

            cancel_order(
                0,
                &mut shorter,
                &maker_key,
                &market_map,
                &mut oracle_map,
                clock.unix_timestamp,
                clock.slot,
                OrderActionExplanation::None,
                None,
                0,
                true,
            )
            .unwrap();

            let mut market = market_map.get_ref_mut(&0).unwrap();
            assert_eq!(market.pnl_pool.balance, 1000000000);

            let orig_short_balance = shorter.bank_balances[0].balance;

            assert_eq!(orig_short_balance, 20000000000);
            assert_eq!(shorter.positions[0].base_asset_amount, -10000000000000000);
            assert_eq!(shorter.positions[0].quote_asset_amount, 97000000000);
            drop(market);

            settle_expired_position(
                0,
                &mut shorter,
                &maker_key,
                &market_map,
                &bank_map,
                &mut oracle_map,
                clock.unix_timestamp,
                &state.fee_structure,
            )
            .unwrap();

            assert_eq!(shorter.bank_balances[0].balance > 100000000, true);
            assert_eq!(shorter.bank_balances[0].balance, 3370250001);

            let shorter_loss = orig_short_balance - shorter.bank_balances[0].balance;
            assert_eq!(shorter_loss, 16_629_749_999); //$16629 loss

            let mut market = market_map.get_ref_mut(&0).unwrap();
            assert_eq!(market.pnl_pool.balance, 24370250000); //$24370
            assert_eq!(market.amm.fee_pool.balance, 0);
            drop(market);

            assert_eq!(shorter.positions[0].open_orders, 0);
            assert_eq!(shorter.positions[0].base_asset_amount, 0);
            assert_eq!(shorter.positions[0].quote_asset_amount, 0);
            assert_eq!(shorter.positions[0].quote_entry_amount, 0);
        }

        // do long close
        {
            let (margin_requirement, total_collateral) =
                calculate_margin_requirement_and_total_collateral(
                    &longer,
                    &market_map,
                    MarginRequirementType::Maintenance,
                    &bank_map,
                    &mut oracle_map,
                )
                .unwrap();

            assert_eq!(total_collateral, 20000000000);
            assert_eq!(margin_requirement, 1208512500);

            // open orders fails
            assert_eq!(
                settle_expired_position(
                    0,
                    &mut longer,
                    &taker_key,
                    &market_map,
                    &bank_map,
                    &mut oracle_map,
                    clock.unix_timestamp,
                    &state.fee_structure
                )
                .is_err(),
                true
            );

            cancel_order(
                0,
                &mut longer,
                &taker_key,
                &market_map,
                &mut oracle_map,
                clock.unix_timestamp,
                clock.slot,
                OrderActionExplanation::None,
                None,
                0,
                true,
            )
            .unwrap();

            let mut market = market_map.get_ref_mut(&0).unwrap();
            assert_eq!(market.pnl_pool.balance, 24370250000);
            assert_eq!(longer.bank_balances[0].balance, 20000000000);
            assert_eq!(longer.positions[0].quote_asset_amount, 200000000);
            assert_eq!(
                longer.positions[0].quote_asset_amount,
                market.amm.quote_asset_amount_long
            );
            drop(market);

            settle_expired_position(
                0,
                &mut longer,
                &taker_key,
                &market_map,
                &bank_map,
                &mut oracle_map,
                clock.unix_timestamp,
                &state.fee_structure,
            )
            .unwrap();

            assert_eq!(longer.bank_balances[0].balance > 100000000, true);
            assert_eq!(longer.bank_balances[0].balance, 44225950000); //$44225.95

            let mut market = market_map.get_ref_mut(&0).unwrap();
            assert_eq!(market.pnl_pool.balance, 144_299_999); // fees collected
            assert_eq!(market.amm.fee_pool.balance, 0);
            drop(market);

            assert_eq!(longer.positions[0].open_orders, 0);
            assert_eq!(longer.positions[0].base_asset_amount, 0);
            assert_eq!(longer.positions[0].quote_asset_amount, 0);
            assert_eq!(longer.positions[0].quote_entry_amount, 0);
        }
    }
}
