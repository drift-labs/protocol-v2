pub mod liquidate_perp {
    use crate::controller::liquidation::liquidate_perp;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION,
        BANK_WEIGHT_PRECISION, BASE_PRECISION, BASE_PRECISION_I128, LIQUIDATION_FEE_PRECISION,
        PEG_PRECISION, QUOTE_PRECISION,
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
                quote_asset_amount_long: 150 * QUOTE_PRECISION,
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
                quote_asset_amount: 150 * QUOTE_PRECISION,
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

        liquidate_perp(
            0,
            BASE_PRECISION,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
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
            user.positions[0].unsettled_pnl,
            -51 * (QUOTE_PRECISION as i128)
        );
        assert_eq!(user.positions[0].open_orders, 0);
        assert_eq!(user.positions[0].open_bids, 0);

        assert_eq!(
            liquidator.positions[0].base_asset_amount,
            BASE_PRECISION_I128
        );
        assert_eq!(liquidator.positions[0].unsettled_pnl, 0);
        assert_eq!(
            liquidator.positions[0].quote_asset_amount,
            99 * QUOTE_PRECISION
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
                quote_asset_amount_short: 50 * QUOTE_PRECISION,
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
                quote_asset_amount: 50 * QUOTE_PRECISION,
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

        liquidate_perp(
            0,
            BASE_PRECISION,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
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
            user.positions[0].unsettled_pnl,
            -51 * (QUOTE_PRECISION as i128)
        );
        assert_eq!(user.positions[0].open_orders, 0);
        assert_eq!(user.positions[0].open_bids, 0);

        assert_eq!(
            liquidator.positions[0].base_asset_amount,
            -BASE_PRECISION_I128
        );
        assert_eq!(liquidator.positions[0].unsettled_pnl, 0);
        assert_eq!(
            liquidator.positions[0].quote_asset_amount,
            101 * QUOTE_PRECISION
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
                quote_asset_amount_short: 50 * QUOTE_PRECISION,
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
                quote_asset_amount: 100 * QUOTE_PRECISION,
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

        liquidate_perp(
            0,
            BASE_PRECISION,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
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
        assert_eq!(user.positions[0].unsettled_pnl, 0,);
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
                quote_asset_amount_long: 150 * QUOTE_PRECISION,
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
                quote_asset_amount: 150 * QUOTE_PRECISION,
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

        liquidate_perp(
            0,
            BASE_PRECISION / 2,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
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
        assert_eq!(user.positions[0].unsettled_pnl, -25500000);
        assert_eq!(user.positions[0].open_orders, 0);
        assert_eq!(user.positions[0].open_bids, 0);

        assert_eq!(
            liquidator.positions[0].base_asset_amount,
            BASE_PRECISION_I128 / 2
        );
        assert_eq!(liquidator.positions[0].unsettled_pnl, 0);
        assert_eq!(liquidator.positions[0].quote_asset_amount, 49500000);
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
                quote_asset_amount_long: 150 * QUOTE_PRECISION,
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
                quote_asset_amount: 200 * QUOTE_PRECISION,
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

        liquidate_perp(
            0,
            10 * BASE_PRECISION,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
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
        assert_eq!(user.positions[0].unsettled_pnl, -1287500);
        assert_eq!(user.positions[0].open_orders, 0);
        assert_eq!(user.positions[0].open_bids, 0);

        assert_eq!(liquidator.positions[0].base_asset_amount, 12875000000000);
        assert_eq!(liquidator.positions[0].quote_asset_amount, 127462500);
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
        QUOTE_PRECISION,
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
                quote_asset_amount_long: 150 * QUOTE_PRECISION,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unsettled_initial_asset_weight: 80,
            unsettled_maintenance_asset_weight: 90,
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
                unsettled_pnl: 100 * QUOTE_PRECISION as i128,
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
        assert_eq!(user.positions[0].unsettled_pnl, 19119120);

        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Borrow
        );
        assert_eq!(liquidator.bank_balances[1].balance, 800001);
        assert_eq!(liquidator.positions[0].unsettled_pnl, 80880880);
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
                quote_asset_amount_long: 150 * QUOTE_PRECISION,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unsettled_initial_asset_weight: 80,
            unsettled_maintenance_asset_weight: 90,
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
                unsettled_pnl: 110 * QUOTE_PRECISION as i128,
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
        assert_eq!(user.positions[0].unsettled_pnl, 45648442);

        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Borrow
        );
        assert_eq!(liquidator.bank_balances[1].balance, 636508);
        assert_eq!(liquidator.positions[0].unsettled_pnl, 64351558);
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
                quote_asset_amount_long: 150 * QUOTE_PRECISION,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unsettled_initial_asset_weight: 80,
            unsettled_maintenance_asset_weight: 90,
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
                unsettled_pnl: 80 * QUOTE_PRECISION as i128,
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
        assert_eq!(user.positions[0].unsettled_pnl, 0);

        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Borrow
        );
        assert_eq!(liquidator.bank_balances[1].balance, 791288);
        assert_eq!(liquidator.positions[0].unsettled_pnl, 80000000);
    }
}

pub mod liquidate_perp_pnl_for_deposit {
    use crate::controller::liquidation::liquidate_perp_pnl_for_deposit;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION,
        BANK_WEIGHT_PRECISION, BASE_PRECISION_I128, LIQUIDATION_FEE_PRECISION, PEG_PRECISION,
        QUOTE_PRECISION,
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
                quote_asset_amount_long: 150 * QUOTE_PRECISION,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unsettled_initial_asset_weight: 80,
            unsettled_maintenance_asset_weight: 90,
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
                unsettled_pnl: -100 * QUOTE_PRECISION as i128,
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
        assert_eq!(user.positions[0].unsettled_pnl, -50000000);

        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Deposit
        );
        assert_eq!(liquidator.bank_balances[1].balance, 505555);
        assert_eq!(liquidator.positions[0].unsettled_pnl, -50000000);
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
                quote_asset_amount_long: 150 * QUOTE_PRECISION,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unsettled_initial_asset_weight: 80,
            unsettled_maintenance_asset_weight: 90,
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
                unsettled_pnl: -91 * QUOTE_PRECISION as i128,
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
        assert_eq!(user.positions[0].unsettled_pnl, -79888889);

        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Deposit
        );
        assert_eq!(liquidator.bank_balances[1].balance, 112345);
        assert_eq!(liquidator.positions[0].unsettled_pnl, -11111111);
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
                quote_asset_amount_long: 150 * QUOTE_PRECISION,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unsettled_initial_asset_weight: 80,
            unsettled_maintenance_asset_weight: 90,
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
                unsettled_pnl: -150 * QUOTE_PRECISION as i128,
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
        assert_eq!(user.positions[0].unsettled_pnl, -51098902);

        assert_eq!(
            liquidator.bank_balances[1].balance_type,
            BankBalanceType::Deposit
        );
        assert_eq!(liquidator.bank_balances[1].balance, 1000000);
        assert_eq!(liquidator.positions[0].unsettled_pnl, -98901098);
    }
}
