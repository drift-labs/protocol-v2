pub mod liquidate_perp {
    use crate::controller::liquidation::liquidate_perp;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION,
        BANK_WEIGHT_PRECISION, BASE_PRECISION, BASE_PRECISION_I128, LIQUIDATION_FEE_PRECISION,
        PEG_PRECISION, QUOTE_PRECISION_I128,
    };
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::BankMap;
    use crate::state::market::{Market, AMM};
    use crate::state::market_map::MarketMap;
    use crate::state::oracle::OracleSource;
    use crate::state::oracle_map::OracleMap;
    use crate::state::user::{
        MarketPosition, Order, OrderStatus, OrderType, User, UserBankBalance, UserStats,
    };
    use crate::tests::utils::get_pyth_price;
    use crate::tests::utils::*;
    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    pub fn successful_liquidation_long_perp() {
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
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
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

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I128,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                quote_entry_amount: -150 * QUOTE_PRECISION_I128,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: [UserBankBalance::default(); 8],

            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 50 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();

        liquidate_perp(
            0,
            BASE_PRECISION,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &bank_map,
            &mut oracle_map,
            slot,
            now,
            10,
            0,
        )
        .unwrap();

        assert_eq!(user.positions[0].base_asset_amount, 0);
        assert_eq!(
            user.positions[0].quote_asset_amount,
            -51 * QUOTE_PRECISION_I128
        );
        assert_eq!(user.positions[0].open_orders, 0);
        assert_eq!(user.positions[0].open_bids, 0);

        assert_eq!(
            liquidator.positions[0].base_asset_amount,
            BASE_PRECISION_I128
        );
        assert_eq!(
            liquidator.positions[0].quote_asset_amount,
            -99 * QUOTE_PRECISION_I128
        );
    }

    #[test]
    pub fn successful_liquidation_short_perp() {
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
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
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

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                base_asset_amount: -BASE_PRECISION_I128,
                quote_asset_amount: 50 * QUOTE_PRECISION_I128,
                quote_entry_amount: 50 * QUOTE_PRECISION_I128,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: [UserBankBalance::default(); 8],

            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 50 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();

        liquidate_perp(
            0,
            BASE_PRECISION,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &bank_map,
            &mut oracle_map,
            slot,
            now,
            10,
            0,
        )
        .unwrap();

        assert_eq!(user.positions[0].base_asset_amount, 0);
        assert_eq!(
            user.positions[0].quote_asset_amount,
            -51 * QUOTE_PRECISION_I128
        );
        assert_eq!(user.positions[0].open_orders, 0);
        assert_eq!(user.positions[0].open_bids, 0);

        assert_eq!(
            liquidator.positions[0].base_asset_amount,
            -BASE_PRECISION_I128
        );
        assert_eq!(
            liquidator.positions[0].quote_asset_amount,
            101 * QUOTE_PRECISION_I128
        );
    }

    #[test]
    pub fn successful_liquidation_by_canceling_order() {
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
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
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
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: 1000 * BASE_PRECISION,
                ts: 0,
                slot: 0,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I128,
                quote_asset_amount: 100 * QUOTE_PRECISION_I128,
                open_orders: 1,
                open_bids: 1000 * BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 50 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 50 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();

        liquidate_perp(
            0,
            BASE_PRECISION,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &bank_map,
            &mut oracle_map,
            slot,
            now,
            255,
            0,
        )
        .unwrap();

        assert_eq!(user.positions[0].base_asset_amount, BASE_PRECISION_I128);
        assert_eq!(user.positions[0].open_orders, 0);
        assert_eq!(user.positions[0].open_bids, 0);

        assert_eq!(liquidator.positions[0].base_asset_amount, 0);
    }

    #[test]
    pub fn successful_liquidation_up_to_max_liquidator_base_asset_amount() {
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
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
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

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I128,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                quote_entry_amount: -150 * QUOTE_PRECISION_I128,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: [UserBankBalance::default(); 8],

            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 50 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();

        liquidate_perp(
            0,
            BASE_PRECISION / 2,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &bank_map,
            &mut oracle_map,
            slot,
            now,
            10,
            0,
        )
        .unwrap();

        assert_eq!(user.positions[0].base_asset_amount, BASE_PRECISION_I128 / 2);
        assert_eq!(user.positions[0].quote_asset_amount, -100500000);
        assert_eq!(user.positions[0].quote_entry_amount, -75000000);
        assert_eq!(user.positions[0].open_orders, 0);
        assert_eq!(user.positions[0].open_bids, 0);

        assert_eq!(
            liquidator.positions[0].base_asset_amount,
            BASE_PRECISION_I128 / 2
        );
        assert_eq!(liquidator.positions[0].quote_asset_amount, -49500000);
    }

    #[test]
    pub fn successful_liquidation_to_cover_margin_shortage() {
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
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
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
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                base_asset_amount: 2 * BASE_PRECISION_I128,
                quote_asset_amount: -200 * QUOTE_PRECISION_I128,
                quote_entry_amount: -200 * QUOTE_PRECISION_I128,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 5 * BANK_INTEREST_PRECISION,
            }),

            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 50 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();

        liquidate_perp(
            0,
            10 * BASE_PRECISION,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &bank_map,
            &mut oracle_map,
            slot,
            now,
            100,
            0,
        )
        .unwrap();

        assert_eq!(user.positions[0].base_asset_amount, 7125000000000);
        assert_eq!(user.positions[0].quote_asset_amount, -72537500);
        assert_eq!(user.positions[0].quote_entry_amount, -71250000);
        assert_eq!(user.positions[0].open_orders, 0);
        assert_eq!(user.positions[0].open_bids, 0);

        assert_eq!(liquidator.positions[0].base_asset_amount, 12875000000000);
        assert_eq!(liquidator.positions[0].quote_asset_amount, -127462500);
    }
}

pub mod liquidate_borrow {
    use crate::controller::liquidation::liquidate_borrow;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION, BANK_WEIGHT_PRECISION,
        LIQUIDATION_FEE_PRECISION,
    };
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::BankMap;
    use crate::state::market_map::MarketMap;
    use crate::state::oracle::OracleSource;
    use crate::state::oracle_map::OracleMap;
    use crate::state::user::{MarketPosition, Order, User, UserBankBalance};
    use crate::tests::utils::get_pyth_price;
    use crate::tests::utils::*;
    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    pub fn successful_liquidation_liability_transfer_implied_by_asset_amount() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 10);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot).unwrap();

        let market_map = MarketMap::empty();

        let mut usdc_bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 200 * BANK_INTEREST_PRECISION,
            liquidation_fee: 0,
            ..Bank::default()
        };
        create_anchor_account_info!(usdc_bank, Bank, usdc_bank_account_info);
        let mut sol_bank = Bank {
            bank_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * BANK_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * BANK_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * BANK_WEIGHT_PRECISION / 10,
            deposit_balance: BANK_INTEREST_PRECISION,
            borrow_balance: BANK_INTEREST_PRECISION,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..Bank::default()
        };
        create_anchor_account_info!(sol_bank, Bank, sol_bank_account_info);
        let bank_account_infos = Vec::from([&usdc_bank_account_info, &sol_bank_account_info]);
        let bank_map = BankMap::load_multiple(bank_account_infos, true).unwrap();

        let mut user_bank_balances = [UserBankBalance::default(); 8];
        user_bank_balances[0] = UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 100 * BANK_INTEREST_PRECISION,
        };
        user_bank_balances[1] = UserBankBalance {
            bank_index: 1,
            balance_type: BankBalanceType::Borrow,
            balance: BANK_INTEREST_PRECISION,
        };
        let mut user = User {
            orders: [Order::default(); 32],
            positions: [MarketPosition::default(); 5],
            bank_balances: user_bank_balances,
            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_borrow(
            0,
            1,
            10_u128.pow(6),
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            10,
        )
        .unwrap();

        assert_eq!(user.bank_balances[0].balance, 0);
        assert_eq!(user.bank_balances[1].balance, 999);

        assert_eq!(
            liquidator.bank_balances[0].balance_type,
            BankBalanceType::Deposit
        );
        assert_eq!(liquidator.bank_balances[0].balance, 200000000);
        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Borrow
        );
        assert_eq!(liquidator.bank_balances[1].balance, 999001);
    }

    #[test]
    pub fn successful_liquidation_liquidator_max_liability_transfer() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 10);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot).unwrap();

        let market_map = MarketMap::empty();

        let mut usdc_bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 200 * BANK_INTEREST_PRECISION,
            liquidation_fee: 0,
            ..Bank::default()
        };
        create_anchor_account_info!(usdc_bank, Bank, usdc_bank_account_info);
        let mut sol_bank = Bank {
            bank_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * BANK_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * BANK_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * BANK_WEIGHT_PRECISION / 10,
            deposit_balance: BANK_INTEREST_PRECISION,
            borrow_balance: BANK_INTEREST_PRECISION,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..Bank::default()
        };
        create_anchor_account_info!(sol_bank, Bank, sol_bank_account_info);
        let bank_account_infos = Vec::from([&usdc_bank_account_info, &sol_bank_account_info]);
        let bank_map = BankMap::load_multiple(bank_account_infos, true).unwrap();

        let mut user_bank_balances = [UserBankBalance::default(); 8];
        user_bank_balances[0] = UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 100 * BANK_INTEREST_PRECISION,
        };
        user_bank_balances[1] = UserBankBalance {
            bank_index: 1,
            balance_type: BankBalanceType::Borrow,
            balance: BANK_INTEREST_PRECISION,
        };
        let mut user = User {
            orders: [Order::default(); 32],
            positions: [MarketPosition::default(); 5],
            bank_balances: user_bank_balances,
            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_borrow(
            0,
            1,
            10_u128.pow(6) / 10,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            10,
        )
        .unwrap();

        assert_eq!(user.bank_balances[0].balance, 89989990);
        assert_eq!(user.bank_balances[1].balance, 899999);

        assert_eq!(
            liquidator.bank_balances[0].balance_type,
            BankBalanceType::Deposit
        );
        assert_eq!(liquidator.bank_balances[0].balance, 110010010);
        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Borrow
        );
        assert_eq!(liquidator.bank_balances[1].balance, 100001);
    }

    #[test]
    pub fn successful_liquidation_liability_transfer_to_cover_margin_shortage() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 10);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot).unwrap();

        let market_map = MarketMap::empty();

        let mut usdc_bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 200 * BANK_INTEREST_PRECISION,
            liquidation_fee: 0,
            ..Bank::default()
        };
        create_anchor_account_info!(usdc_bank, Bank, usdc_bank_account_info);
        let mut sol_bank = Bank {
            bank_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * BANK_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * BANK_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * BANK_WEIGHT_PRECISION / 10,
            deposit_balance: BANK_INTEREST_PRECISION,
            borrow_balance: BANK_INTEREST_PRECISION,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..Bank::default()
        };
        create_anchor_account_info!(sol_bank, Bank, sol_bank_account_info);
        let bank_account_infos = Vec::from([&usdc_bank_account_info, &sol_bank_account_info]);
        let bank_map = BankMap::load_multiple(bank_account_infos, true).unwrap();

        let mut user_bank_balances = [UserBankBalance::default(); 8];
        user_bank_balances[0] = UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 105 * BANK_INTEREST_PRECISION,
        };
        user_bank_balances[1] = UserBankBalance {
            bank_index: 1,
            balance_type: BankBalanceType::Borrow,
            balance: BANK_INTEREST_PRECISION,
        };
        let mut user = User {
            orders: [Order::default(); 32],
            positions: [MarketPosition::default(); 5],
            bank_balances: user_bank_balances,
            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_borrow(
            0,
            1,
            10_u128.pow(6),
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            100,
        )
        .unwrap();

        assert_eq!(user.bank_balances[0].balance, 43322223);
        assert_eq!(user.bank_balances[1].balance, 383838);

        assert_eq!(
            liquidator.bank_balances[0].balance_type,
            BankBalanceType::Deposit
        );
        assert_eq!(liquidator.bank_balances[0].balance, 161677777);
        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Borrow
        );
        assert_eq!(liquidator.bank_balances[1].balance, 616162);
    }
}

pub mod liquidate_borrow_for_perp_pnl {
    use crate::controller::liquidation::liquidate_borrow_for_perp_pnl;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION,
        BANK_WEIGHT_PRECISION, BASE_PRECISION_I128, LIQUIDATION_FEE_PRECISION, PEG_PRECISION,
        QUOTE_PRECISION_I128,
    };
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::BankMap;
    use crate::state::market::{Market, AMM};
    use crate::state::market_map::MarketMap;
    use crate::state::oracle::OracleSource;
    use crate::state::oracle_map::OracleMap;
    use crate::state::user::{MarketPosition, Order, User, UserBankBalance};
    use crate::tests::utils::get_pyth_price;
    use crate::tests::utils::*;
    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    pub fn successful_liquidation_liquidator_max_liability_transfer() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 10);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
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
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_long: 150 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_initial_asset_weight: 80,
            unrealized_maintenance_asset_weight: 90,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..Market::default()
        };
        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 200 * BANK_INTEREST_PRECISION,
            liquidation_fee: 0,
            ..Bank::default()
        };
        create_anchor_account_info!(usdc_bank, Bank, usdc_bank_account_info);
        let mut sol_bank = Bank {
            bank_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * BANK_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * BANK_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * BANK_WEIGHT_PRECISION / 10,
            deposit_balance: BANK_INTEREST_PRECISION,
            borrow_balance: BANK_INTEREST_PRECISION,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..Bank::default()
        };
        create_anchor_account_info!(sol_bank, Bank, sol_bank_account_info);
        let bank_account_infos = Vec::from([&usdc_bank_account_info, &sol_bank_account_info]);
        let bank_map = BankMap::load_multiple(bank_account_infos, true).unwrap();

        let mut user_bank_balances = [UserBankBalance::default(); 8];
        user_bank_balances[0] = UserBankBalance {
            bank_index: 1,
            balance_type: BankBalanceType::Borrow,
            balance: BANK_INTEREST_PRECISION,
        };
        let mut user = User {
            orders: [Order::default(); 32],
            positions: get_positions(MarketPosition {
                market_index: 0,
                quote_asset_amount: 100 * QUOTE_PRECISION_I128 as i128,
                ..MarketPosition::default()
            }),
            bank_balances: user_bank_balances,
            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_borrow_for_perp_pnl(
            0,
            1,
            8 * 10_u128.pow(5), // .8
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            10,
        )
        .unwrap();

        assert_eq!(user.bank_balances[0].balance, 199999);
        assert_eq!(user.positions[0].quote_asset_amount, 19119120);

        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Borrow
        );
        assert_eq!(liquidator.bank_balances[1].balance, 800001);
        assert_eq!(liquidator.positions[0].quote_asset_amount, 80880880);
    }

    #[test]
    pub fn successful_liquidation_liability_transfer_to_cover_margin_shortage() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 10);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
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
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_long: 150 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_initial_asset_weight: 80,
            unrealized_maintenance_asset_weight: 90,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..Market::default()
        };
        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 200 * BANK_INTEREST_PRECISION,
            liquidation_fee: 0,
            ..Bank::default()
        };
        create_anchor_account_info!(usdc_bank, Bank, usdc_bank_account_info);
        let mut sol_bank = Bank {
            bank_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * BANK_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * BANK_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * BANK_WEIGHT_PRECISION / 10,
            deposit_balance: BANK_INTEREST_PRECISION,
            borrow_balance: BANK_INTEREST_PRECISION,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..Bank::default()
        };
        create_anchor_account_info!(sol_bank, Bank, sol_bank_account_info);
        let bank_account_infos = Vec::from([&usdc_bank_account_info, &sol_bank_account_info]);
        let bank_map = BankMap::load_multiple(bank_account_infos, true).unwrap();

        let mut user_bank_balances = [UserBankBalance::default(); 8];
        user_bank_balances[0] = UserBankBalance {
            bank_index: 1,
            balance_type: BankBalanceType::Borrow,
            balance: BANK_INTEREST_PRECISION,
        };
        let mut user = User {
            orders: [Order::default(); 32],
            positions: get_positions(MarketPosition {
                market_index: 0,
                quote_asset_amount: 110 * QUOTE_PRECISION_I128 as i128,
                ..MarketPosition::default()
            }),
            bank_balances: user_bank_balances,
            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_borrow_for_perp_pnl(
            0,
            1,
            2 * 10_u128.pow(6),
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            100,
        )
        .unwrap();

        assert_eq!(user.bank_balances[0].balance, 363492);
        assert_eq!(user.positions[0].quote_asset_amount, 45648442);

        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Borrow
        );
        assert_eq!(liquidator.bank_balances[1].balance, 636508);
        assert_eq!(liquidator.positions[0].quote_asset_amount, 64351558);
    }

    #[test]
    pub fn successful_liquidation_liability_transfer_implied_by_pnl() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 10);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
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
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_long: 150 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_initial_asset_weight: 80,
            unrealized_maintenance_asset_weight: 90,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..Market::default()
        };
        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 200 * BANK_INTEREST_PRECISION,
            liquidation_fee: 0,
            ..Bank::default()
        };
        create_anchor_account_info!(usdc_bank, Bank, usdc_bank_account_info);
        let mut sol_bank = Bank {
            bank_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * BANK_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * BANK_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * BANK_WEIGHT_PRECISION / 10,
            deposit_balance: BANK_INTEREST_PRECISION,
            borrow_balance: BANK_INTEREST_PRECISION,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..Bank::default()
        };
        create_anchor_account_info!(sol_bank, Bank, sol_bank_account_info);
        let bank_account_infos = Vec::from([&usdc_bank_account_info, &sol_bank_account_info]);
        let bank_map = BankMap::load_multiple(bank_account_infos, true).unwrap();

        let mut user_bank_balances = [UserBankBalance::default(); 8];
        user_bank_balances[0] = UserBankBalance {
            bank_index: 1,
            balance_type: BankBalanceType::Borrow,
            balance: BANK_INTEREST_PRECISION,
        };
        let mut user = User {
            orders: [Order::default(); 32],
            positions: get_positions(MarketPosition {
                market_index: 0,
                quote_asset_amount: 80 * QUOTE_PRECISION_I128 as i128,
                ..MarketPosition::default()
            }),
            bank_balances: user_bank_balances,
            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_borrow_for_perp_pnl(
            0,
            1,
            2 * 10_u128.pow(6),
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            10,
        )
        .unwrap();

        assert_eq!(user.bank_balances[0].balance, 208712);
        assert_eq!(user.positions[0].quote_asset_amount, 0);

        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Borrow
        );
        assert_eq!(liquidator.bank_balances[1].balance, 791288);
        assert_eq!(liquidator.positions[0].quote_asset_amount, 80000000);
    }
}

pub mod liquidate_perp_pnl_for_deposit {
    use crate::controller::liquidation::liquidate_perp_pnl_for_deposit;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION,
        BANK_WEIGHT_PRECISION, BASE_PRECISION_I128, LIQUIDATION_FEE_PRECISION, PEG_PRECISION,
        QUOTE_PRECISION_I128,
    };
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::BankMap;
    use crate::state::market::{Market, AMM};
    use crate::state::market_map::MarketMap;
    use crate::state::oracle::OracleSource;
    use crate::state::oracle_map::OracleMap;
    use crate::state::user::{MarketPosition, Order, User, UserBankBalance};
    use crate::tests::utils::get_pyth_price;
    use crate::tests::utils::*;
    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    pub fn successful_liquidation_liquidator_max_pnl_transfer() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 10);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
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
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_long: 150 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_initial_asset_weight: 80,
            unrealized_maintenance_asset_weight: 90,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..Market::default()
        };
        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 200 * BANK_INTEREST_PRECISION,
            liquidation_fee: 0,
            ..Bank::default()
        };
        create_anchor_account_info!(usdc_bank, Bank, usdc_bank_account_info);
        let mut sol_bank = Bank {
            bank_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * BANK_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * BANK_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * BANK_WEIGHT_PRECISION / 10,
            deposit_balance: BANK_INTEREST_PRECISION,
            borrow_balance: 0,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..Bank::default()
        };
        create_anchor_account_info!(sol_bank, Bank, sol_bank_account_info);
        let bank_account_infos = Vec::from([&usdc_bank_account_info, &sol_bank_account_info]);
        let bank_map = BankMap::load_multiple(bank_account_infos, true).unwrap();

        let mut user_bank_balances = [UserBankBalance::default(); 8];
        user_bank_balances[0] = UserBankBalance {
            bank_index: 1,
            balance_type: BankBalanceType::Deposit,
            balance: BANK_INTEREST_PRECISION,
        };
        let mut user = User {
            orders: [Order::default(); 32],
            positions: get_positions(MarketPosition {
                market_index: 0,
                quote_asset_amount: -100 * QUOTE_PRECISION_I128 as i128,
                ..MarketPosition::default()
            }),
            bank_balances: user_bank_balances,
            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_perp_pnl_for_deposit(
            0,
            1,
            50 * 10_u128.pow(6), // .8
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            10,
        )
        .unwrap();

        assert_eq!(user.bank_balances[0].balance, 494445);
        assert_eq!(user.positions[0].quote_asset_amount, -50000000);

        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Deposit
        );
        assert_eq!(liquidator.bank_balances[1].balance, 505555);
        assert_eq!(liquidator.positions[0].quote_asset_amount, -50000000);
    }

    #[test]
    pub fn successful_liquidation_pnl_transfer_to_cover_margin_shortage() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 10);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
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
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_long: 150 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_initial_asset_weight: 80,
            unrealized_maintenance_asset_weight: 90,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..Market::default()
        };
        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 200 * BANK_INTEREST_PRECISION,
            liquidation_fee: 0,
            ..Bank::default()
        };
        create_anchor_account_info!(usdc_bank, Bank, usdc_bank_account_info);
        let mut sol_bank = Bank {
            bank_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * BANK_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * BANK_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * BANK_WEIGHT_PRECISION / 10,
            deposit_balance: BANK_INTEREST_PRECISION,
            borrow_balance: 0,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..Bank::default()
        };
        create_anchor_account_info!(sol_bank, Bank, sol_bank_account_info);
        let bank_account_infos = Vec::from([&usdc_bank_account_info, &sol_bank_account_info]);
        let bank_map = BankMap::load_multiple(bank_account_infos, true).unwrap();

        let mut user_bank_balances = [UserBankBalance::default(); 8];
        user_bank_balances[0] = UserBankBalance {
            bank_index: 1,
            balance_type: BankBalanceType::Deposit,
            balance: BANK_INTEREST_PRECISION,
        };
        let mut user = User {
            orders: [Order::default(); 32],
            positions: get_positions(MarketPosition {
                market_index: 0,
                quote_asset_amount: -91 * QUOTE_PRECISION_I128 as i128,
                ..MarketPosition::default()
            }),
            bank_balances: user_bank_balances,
            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_perp_pnl_for_deposit(
            0,
            1,
            200 * 10_u128.pow(6), // .8
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            10,
        )
        .unwrap();

        assert_eq!(user.bank_balances[0].balance, 887655);
        assert_eq!(user.positions[0].quote_asset_amount, -79888889);

        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Deposit
        );
        assert_eq!(liquidator.bank_balances[1].balance, 112345);
        assert_eq!(liquidator.positions[0].quote_asset_amount, -11111111);
    }

    #[test]
    pub fn successful_liquidation_pnl_transfer_implied_by_asset_amount() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 10);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
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
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_long: 150 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_initial_asset_weight: 80,
            unrealized_maintenance_asset_weight: 90,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..Market::default()
        };
        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            maintenance_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 200 * BANK_INTEREST_PRECISION,
            liquidation_fee: 0,
            ..Bank::default()
        };
        create_anchor_account_info!(usdc_bank, Bank, usdc_bank_account_info);
        let mut sol_bank = Bank {
            bank_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * BANK_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * BANK_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * BANK_WEIGHT_PRECISION / 10,
            deposit_balance: BANK_INTEREST_PRECISION,
            borrow_balance: 0,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..Bank::default()
        };
        create_anchor_account_info!(sol_bank, Bank, sol_bank_account_info);
        let bank_account_infos = Vec::from([&usdc_bank_account_info, &sol_bank_account_info]);
        let bank_map = BankMap::load_multiple(bank_account_infos, true).unwrap();

        let mut user_bank_balances = [UserBankBalance::default(); 8];
        user_bank_balances[0] = UserBankBalance {
            bank_index: 1,
            balance_type: BankBalanceType::Deposit,
            balance: BANK_INTEREST_PRECISION,
        };
        let mut user = User {
            orders: [Order::default(); 32],
            positions: get_positions(MarketPosition {
                market_index: 0,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128 as i128,
                ..MarketPosition::default()
            }),
            bank_balances: user_bank_balances,
            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 100 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_perp_pnl_for_deposit(
            0,
            1,
            200 * 10_u128.pow(6), // .8
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            10,
        )
        .unwrap();

        assert_eq!(user.bank_balances[0].balance, 0);
        assert_eq!(user.positions[0].quote_asset_amount, -51098902);

        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Deposit
        );
        assert_eq!(liquidator.bank_balances[1].balance, 1000000);
        assert_eq!(liquidator.positions[0].quote_asset_amount, -98901098);
    }
}

pub mod resolve_perp_bankruptcy {
    use crate::controller::funding::settle_funding_payment;
    use crate::controller::liquidation::resolve_perp_bankruptcy;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION,
        BANK_WEIGHT_PRECISION, BASE_PRECISION, BASE_PRECISION_I128, FUNDING_RATE_PRECISION_I128,
        LIQUIDATION_FEE_PRECISION, PEG_PRECISION, QUOTE_PRECISION_I128,
    };
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::BankMap;
    use crate::state::market::{Market, AMM};
    use crate::state::market_map::MarketMap;
    use crate::state::oracle::OracleSource;
    use crate::state::oracle_map::OracleMap;
    use crate::state::user::{
        MarketPosition, Order, OrderStatus, OrderType, User, UserBankBalance,
    };
    use crate::tests::utils::get_pyth_price;
    use crate::tests::utils::*;
    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    pub fn successful_resolve_perp_bankruptcy() {
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
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                cumulative_funding_rate_long: 1000 * FUNDING_RATE_PRECISION_I128,
                cumulative_funding_rate_short: -1000 * FUNDING_RATE_PRECISION_I128,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            base_asset_amount_long: 5 * BASE_PRECISION_I128,
            base_asset_amount_short: -5 * BASE_PRECISION_I128,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
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

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                ..Order::default()
            }),
            positions: get_positions(MarketPosition {
                market_index: 0,
                base_asset_amount: 0,
                quote_asset_amount: -100 * QUOTE_PRECISION_I128,
                open_orders: 1,
                open_bids: BASE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: [UserBankBalance::default(); 8],
            bankrupt: true,
            being_liquidated: false,
            next_liquidation_id: 2,
            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 50 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut expected_user = user;
        expected_user.being_liquidated = false;
        expected_user.bankrupt = false;
        expected_user.positions[0].quote_asset_amount = 0;

        let mut expected_market = market;
        expected_market.amm.cumulative_funding_rate_long = 1010 * FUNDING_RATE_PRECISION_I128;
        expected_market.amm.cumulative_funding_rate_short = -1010 * FUNDING_RATE_PRECISION_I128;

        resolve_perp_bankruptcy(
            0,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            0,
        )
        .unwrap();

        assert_eq!(expected_user, user);
        assert_eq!(expected_market, market_map.get_ref(&0).unwrap().clone());

        let mut affected_long_user = User {
            orders: [Order::default(); 32],
            positions: get_positions(MarketPosition {
                market_index: 0,
                base_asset_amount: 5 * BASE_PRECISION_I128,
                quote_asset_amount: -500 * QUOTE_PRECISION_I128,
                open_bids: BASE_PRECISION_I128,
                last_cumulative_funding_rate: 1000 * FUNDING_RATE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: [UserBankBalance::default(); 8],
            ..User::default()
        };

        let mut expected_affected_long_user = affected_long_user;
        expected_affected_long_user.positions[0].quote_asset_amount = -550 * QUOTE_PRECISION_I128; // loses $50
        expected_affected_long_user.positions[0].last_cumulative_funding_rate =
            1010 * FUNDING_RATE_PRECISION_I128;

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
            positions: get_positions(MarketPosition {
                market_index: 0,
                base_asset_amount: -5 * BASE_PRECISION_I128,
                quote_asset_amount: 500 * QUOTE_PRECISION_I128,
                open_bids: BASE_PRECISION_I128,
                last_cumulative_funding_rate: -1000 * FUNDING_RATE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            bank_balances: [UserBankBalance::default(); 8],
            ..User::default()
        };

        let mut expected_affected_short_user = affected_short_user;
        expected_affected_short_user.positions[0].quote_asset_amount = 450 * QUOTE_PRECISION_I128; // loses $50
        expected_affected_short_user.positions[0].last_cumulative_funding_rate =
            -1010 * FUNDING_RATE_PRECISION_I128;

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

pub mod resolve_borrow_bankruptcy {
    use crate::controller::liquidation::resolve_bank_bankruptcy;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::bank_balance::get_token_amount;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION,
        BANK_WEIGHT_PRECISION, BASE_PRECISION, BASE_PRECISION_I128, FUNDING_RATE_PRECISION_I128,
        LIQUIDATION_FEE_PRECISION, PEG_PRECISION, QUOTE_PRECISION, QUOTE_PRECISION_I128,
    };
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::BankMap;
    use crate::state::market::{Market, AMM};
    use crate::state::market_map::MarketMap;
    use crate::state::oracle::OracleSource;
    use crate::state::oracle_map::OracleMap;
    use crate::state::user::{
        MarketPosition, Order, OrderStatus, OrderType, User, UserBankBalance,
    };
    use crate::tests::utils::get_pyth_price;
    use crate::tests::utils::*;
    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    pub fn successful_resolve_borrow_bankruptcy() {
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
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                cumulative_funding_rate_long: 1000 * FUNDING_RATE_PRECISION_I128,
                cumulative_funding_rate_short: -1000 * FUNDING_RATE_PRECISION_I128,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            base_asset_amount_long: 5 * BASE_PRECISION_I128,
            base_asset_amount_short: -5 * BASE_PRECISION_I128,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..Market::default()
        };
        create_anchor_account_info!(market, Market, market_account_info);
        let market_map = MarketMap::load_one(&market_account_info, true).unwrap();

        let mut bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: BANK_WEIGHT_PRECISION,
            deposit_balance: 1000 * BANK_INTEREST_PRECISION,
            borrow_balance: 100 * BANK_INTEREST_PRECISION,
            ..Bank::default()
        };
        create_anchor_account_info!(bank, Bank, bank_account_info);
        let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION,
                ts: 0,
                slot: 0,
                ..Order::default()
            }),
            positions: [MarketPosition::default(); 5],
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance: 100 * BANK_INTEREST_PRECISION,
                balance_type: BankBalanceType::Borrow,
            }),
            bankrupt: true,
            being_liquidated: false,
            next_liquidation_id: 2,
            ..User::default()
        };

        let mut liquidator = User {
            bank_balances: get_bank_balances(UserBankBalance {
                bank_index: 0,
                balance_type: BankBalanceType::Deposit,
                balance: 50 * BANK_INTEREST_PRECISION,
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut expected_user = user;
        expected_user.being_liquidated = false;
        expected_user.bankrupt = false;
        expected_user.bank_balances[0].balance = 0;

        let mut expected_bank = bank;
        expected_bank.borrow_balance = 0;
        expected_bank.cumulative_deposit_interest = 9 * BANK_CUMULATIVE_INTEREST_PRECISION / 10;

        resolve_bank_bankruptcy(
            0,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            0,
        )
        .unwrap();

        assert_eq!(expected_user, user);
        assert_eq!(expected_bank, *bank_map.get_ref(&0).unwrap());

        let bank = bank_map.get_ref_mut(&0).unwrap();
        let deposit_balance = bank.deposit_balance;
        let deposit_token_amount =
            get_token_amount(deposit_balance, &bank, &BankBalanceType::Deposit).unwrap();

        assert_eq!(deposit_token_amount, 900 * QUOTE_PRECISION);
    }
}
