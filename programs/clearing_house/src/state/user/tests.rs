mod get_unsettled_pnl {
    use crate::math::constants::{
        BASE_PRECISION_I128, MARK_PRICE_PRECISION_I128, QUOTE_PRECISION_I128,
    };
    use crate::state::user::{MarketPosition, User};
    use crate::tests::utils::get_positions;

    #[test]
    fn long_negative_unrealized_pnl() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: BASE_PRECISION_I128,
                quote_asset_amount: -100 * QUOTE_PRECISION_I128,
                quote_entry_amount: -100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 50 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, -50 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn long_positive_unrealized_pnl_more_than_max_pnl_to_settle() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: BASE_PRECISION_I128,
                quote_asset_amount: -50 * QUOTE_PRECISION_I128,
                quote_entry_amount: -100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, 50 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn long_positive_unrealized_pnl_less_than_max_pnl_to_settle() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: BASE_PRECISION_I128,
                quote_asset_amount: -50 * QUOTE_PRECISION_I128,
                quote_entry_amount: -100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 75 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, 25 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn long_no_negative_pnl_if_already_settled_to_oracle() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: BASE_PRECISION_I128,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                quote_entry_amount: -100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, 0);
    }

    #[test]
    fn short_negative_unrealized_pnl() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: -BASE_PRECISION_I128,
                quote_asset_amount: 100 * QUOTE_PRECISION_I128,
                quote_entry_amount: 100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, -50 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn short_positive_unrealized_pnl_more_than_max_pnl_to_settle() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: -BASE_PRECISION_I128,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                quote_entry_amount: 100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 50 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, 50 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn short_positive_unrealized_pnl_less_than_max_pnl_to_settle() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: -BASE_PRECISION_I128,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                quote_entry_amount: 100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 125 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, 25 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn short_no_negative_pnl_if_already_settled_to_oracle() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: -BASE_PRECISION_I128,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                quote_entry_amount: 100 * QUOTE_PRECISION_I128,
                ..MarketPosition::default()
            }),
            ..User::default()
        };
        let oracle_price = 150 * MARK_PRICE_PRECISION_I128;
        let unsettled_pnl = user.positions[0].get_unsettled_pnl(oracle_price).unwrap();
        assert_eq!(unsettled_pnl, 0);
    }
}

mod get_worst_case_token_amounts {
    use crate::math::constants::{
        BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION, MARK_PRICE_PRECISION_I128,
        QUOTE_PRECISION_I128,
    };
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::oracle::{OraclePriceData, OracleSource};
    use crate::state::user::UserBankBalance;

    #[test]
    fn no_token_open_bid() {
        let user_bank_balance = UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 0,
            open_orders: 1,
            open_bids: 10_i128.pow(9),
            open_asks: 0,
        };

        let bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..Bank::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * MARK_PRICE_PRECISION_I128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_quote_token_amount) = user_bank_balance
            .get_worst_case_token_amounts(&bank, &oracle_price_data)
            .unwrap();

        assert_eq!(worst_case_token_amount, 10_i128.pow(9));
        assert_eq!(worst_case_quote_token_amount, -100 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn no_token_open_ask() {
        let user_bank_balance = UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 0,
            open_orders: 1,
            open_bids: 0,
            open_asks: -(10_i128.pow(9)),
        };

        let bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..Bank::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * MARK_PRICE_PRECISION_I128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_quote_token_amount) = user_bank_balance
            .get_worst_case_token_amounts(&bank, &oracle_price_data)
            .unwrap();

        assert_eq!(worst_case_token_amount, -(10_i128.pow(9)));
        assert_eq!(worst_case_quote_token_amount, 100 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn deposit_and_open_ask() {
        let user_bank_balance = UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 2 * BANK_INTEREST_PRECISION,
            open_orders: 1,
            open_bids: 0,
            open_asks: -(10_i128.pow(9)),
        };

        let bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..Bank::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * MARK_PRICE_PRECISION_I128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_quote_token_amount) = user_bank_balance
            .get_worst_case_token_amounts(&bank, &oracle_price_data)
            .unwrap();

        assert_eq!(worst_case_token_amount, 2 * 10_i128.pow(9));
        assert_eq!(worst_case_quote_token_amount, 0);
    }

    #[test]
    fn deposit_and_open_ask_flips_to_borrow() {
        let user_bank_balance = UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: BANK_INTEREST_PRECISION,
            open_orders: 1,
            open_bids: 0,
            open_asks: -2 * 10_i128.pow(9),
        };

        let bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..Bank::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * MARK_PRICE_PRECISION_I128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_quote_token_amount) = user_bank_balance
            .get_worst_case_token_amounts(&bank, &oracle_price_data)
            .unwrap();

        assert_eq!(worst_case_token_amount, -(10_i128.pow(9)));
        assert_eq!(worst_case_quote_token_amount, 200 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn deposit_and_open_bid() {
        let user_bank_balance = UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 2 * BANK_INTEREST_PRECISION,
            open_orders: 1,
            open_bids: 0,
            open_asks: 10_i128.pow(9),
        };

        let bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..Bank::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * MARK_PRICE_PRECISION_I128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_quote_token_amount) = user_bank_balance
            .get_worst_case_token_amounts(&bank, &oracle_price_data)
            .unwrap();

        assert_eq!(worst_case_token_amount, 3 * 10_i128.pow(9));
        assert_eq!(worst_case_quote_token_amount, -100 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn borrow_and_open_bid() {
        let user_bank_balance = UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Borrow,
            balance: 2 * BANK_INTEREST_PRECISION,
            open_orders: 1,
            open_bids: 10_i128.pow(9),
            open_asks: 0,
        };

        let bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..Bank::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * MARK_PRICE_PRECISION_I128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_quote_token_amount) = user_bank_balance
            .get_worst_case_token_amounts(&bank, &oracle_price_data)
            .unwrap();

        assert_eq!(worst_case_token_amount, -2 * 10_i128.pow(9));
        assert_eq!(worst_case_quote_token_amount, 0);
    }

    #[test]
    fn borrow_and_open_bid_flips_to_deposit() {
        let user_bank_balance = UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Borrow,
            balance: 2 * BANK_INTEREST_PRECISION,
            open_orders: 1,
            open_bids: 5 * 10_i128.pow(9),
            open_asks: 0,
        };

        let bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..Bank::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * MARK_PRICE_PRECISION_I128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_quote_token_amount) = user_bank_balance
            .get_worst_case_token_amounts(&bank, &oracle_price_data)
            .unwrap();

        assert_eq!(worst_case_token_amount, 3 * 10_i128.pow(9));
        assert_eq!(worst_case_quote_token_amount, -500 * QUOTE_PRECISION_I128);
    }

    #[test]
    fn borrow_and_open_ask() {
        let user_bank_balance = UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Borrow,
            balance: 2 * BANK_INTEREST_PRECISION,
            open_orders: 1,
            open_bids: 0,
            open_asks: -(10_i128.pow(9)),
        };

        let bank = Bank {
            bank_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..Bank::default()
        };

        let oracle_price_data = OraclePriceData {
            price: 100 * MARK_PRICE_PRECISION_I128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let (worst_case_token_amount, worst_case_quote_token_amount) = user_bank_balance
            .get_worst_case_token_amounts(&bank, &oracle_price_data)
            .unwrap();

        assert_eq!(worst_case_token_amount, -3 * 10_i128.pow(9));
        assert_eq!(worst_case_quote_token_amount, 100 * QUOTE_PRECISION_I128);
    }
}

mod bank {
    use crate::math::constants::{BANK_WEIGHT_PRECISION, MARGIN_PRECISION};
    use crate::math::margin::MarginRequirementType;
    use crate::state::bank::Bank;

    #[test]
    fn get_initial_leverage_ratio() {
        let bank = Bank {
            initial_liability_weight: 12 * BANK_WEIGHT_PRECISION / 10,
            ..Bank::default()
        };

        let initial_leverage_ratio = bank
            .get_initial_leverage_ratio(MarginRequirementType::Initial)
            .unwrap();

        assert_eq!(initial_leverage_ratio, 5 * MARGIN_PRECISION);
    }
}

mod market {
    use crate::math::constants::MARGIN_PRECISION;
    use crate::math::margin::MarginRequirementType;
    use crate::state::market::Market;

    #[test]
    fn get_initial_leverage_ratio() {
        let market = Market {
            margin_ratio_initial: (MARGIN_PRECISION / 5) as u32,
            ..Market::default()
        };

        let initial_leverage_ratio =
            market.get_initial_leverage_ratio(MarginRequirementType::Initial);

        assert_eq!(initial_leverage_ratio, 5 * MARGIN_PRECISION);
    }
}
