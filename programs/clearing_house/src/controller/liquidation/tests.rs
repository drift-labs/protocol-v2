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
            margin_ratio_partial: 714,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 10,
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
        )
        .unwrap();

        assert_eq!(user.positions[0].base_asset_amount, 0);
        assert_eq!(
            user.positions[0].unsettled_pnl,
            -60 * (QUOTE_PRECISION as i128)
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
            90 * QUOTE_PRECISION
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
            margin_ratio_partial: 714,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 10,
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
        )
        .unwrap();

        assert_eq!(user.positions[0].base_asset_amount, 0);
        assert_eq!(
            user.positions[0].unsettled_pnl,
            -60 * (QUOTE_PRECISION as i128)
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
            110 * QUOTE_PRECISION
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
            margin_ratio_partial: 714,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 10,
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
            margin_ratio_partial: 714,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            initialized: true,
            liquidation_fee: LIQUIDATION_FEE_PRECISION / 10,
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
        )
        .unwrap();

        assert_eq!(user.positions[0].base_asset_amount, BASE_PRECISION_I128 / 2);
        assert_eq!(
            user.positions[0].unsettled_pnl,
            -30 * (QUOTE_PRECISION as i128)
        );
        assert_eq!(user.positions[0].open_orders, 0);
        assert_eq!(user.positions[0].open_bids, 0);

        assert_eq!(
            liquidator.positions[0].base_asset_amount,
            BASE_PRECISION_I128 / 2
        );
        assert_eq!(liquidator.positions[0].unsettled_pnl, 0);
        assert_eq!(
            liquidator.positions[0].quote_asset_amount,
            45 * QUOTE_PRECISION
        );
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
            margin_ratio_partial: 714,
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
        )
        .unwrap();

        assert_eq!(
            user.positions[0].base_asset_amount,
            75 * BASE_PRECISION_I128 / 100
        );
        assert_eq!(user.positions[0].unsettled_pnl, -1250000);
        assert_eq!(user.positions[0].open_orders, 0);
        assert_eq!(user.positions[0].open_bids, 0);

        assert_eq!(liquidator.positions[0].base_asset_amount, 12500000000000);
        assert_eq!(liquidator.positions[0].quote_asset_amount, 123750000);
    }
}
