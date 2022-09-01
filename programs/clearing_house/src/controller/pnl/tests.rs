use crate::controller::pnl::settle_pnl;
use crate::create_account_info;
use crate::create_anchor_account_info;
use crate::error::ErrorCode;
use crate::math::casting::cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, BANK_INTEREST_PRECISION,
    BANK_WEIGHT_PRECISION, BASE_PRECISION_I128, LIQUIDATION_FEE_PRECISION, PEG_PRECISION,
    QUOTE_PRECISION_I128, QUOTE_PRECISION_I64,
};
use crate::state::bank::{Bank, BankBalanceType};
use crate::state::bank_map::BankMap;
use crate::state::market::{Market, PoolBalance, AMM};
use crate::state::market_map::MarketMap;
use crate::state::oracle::OracleSource;
use crate::state::oracle_map::OracleMap;
use crate::state::user::{MarketPosition, User, UserBankBalance};
use crate::tests::utils::get_pyth_price;
use crate::tests::utils::*;
use anchor_lang::Owner;
use solana_program::pubkey::Pubkey;
use std::str::FromStr;

#[test]
pub fn user_no_position() {
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
        pnl_pool: PoolBalance {
            balance: 50 * BANK_INTEREST_PRECISION,
        },
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
        deposit_balance: 100 * BANK_INTEREST_PRECISION,
        ..Bank::default()
    };
    create_anchor_account_info!(bank, Bank, bank_account_info);
    let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

    let mut user = User {
        positions: [MarketPosition::default(); 5],
        bank_balances: get_bank_balances(UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 50 * BANK_INTEREST_PRECISION,
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &bank_map,
        &mut oracle_map,
        now,
    );

    assert_eq!(result, Err(ErrorCode::UserHasNoPositionInMarket));
}

#[test]
pub fn user_does_not_meet_maintenance_requirement() {
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
        pnl_pool: PoolBalance {
            balance: 50 * BANK_INTEREST_PRECISION,
        },
        unrealized_maintenance_asset_weight: cast(BANK_WEIGHT_PRECISION).unwrap(),
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
        deposit_balance: 100 * BANK_INTEREST_PRECISION,
        ..Bank::default()
    };
    create_anchor_account_info!(bank, Bank, bank_account_info);
    let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

    let mut user = User {
        positions: get_positions(MarketPosition {
            market_index: 0,
            quote_asset_amount: -120 * QUOTE_PRECISION_I128,
            ..MarketPosition::default()
        }),
        bank_balances: get_bank_balances(UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 100 * BANK_INTEREST_PRECISION,
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &bank_map,
        &mut oracle_map,
        now,
    );

    assert_eq!(result, Err(ErrorCode::InsufficientCollateralForSettlingPNL))
}

#[test]
pub fn user_unsettled_negative_pnl() {
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
        pnl_pool: PoolBalance {
            balance: 50 * BANK_INTEREST_PRECISION,
        },
        unrealized_maintenance_asset_weight: cast(BANK_WEIGHT_PRECISION).unwrap(),
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
        deposit_balance: 100 * BANK_INTEREST_PRECISION,
        ..Bank::default()
    };
    create_anchor_account_info!(bank, Bank, bank_account_info);
    let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

    let mut user = User {
        positions: get_positions(MarketPosition {
            market_index: 0,
            quote_asset_amount: -50 * QUOTE_PRECISION_I128,
            ..MarketPosition::default()
        }),
        bank_balances: get_bank_balances(UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 100 * BANK_INTEREST_PRECISION,
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.positions[0].quote_asset_amount = 0;
    expected_user.positions[0].realized_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.bank_balances[0].balance = 49999999;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 100 * BANK_INTEREST_PRECISION;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &bank_map,
        &mut oracle_map,
        now,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_unsettled_positive_pnl_more_than_pool() {
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
        pnl_pool: PoolBalance {
            balance: 50 * BANK_INTEREST_PRECISION,
        },
        unrealized_maintenance_asset_weight: cast(BANK_WEIGHT_PRECISION).unwrap(),
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
        deposit_balance: 100 * BANK_INTEREST_PRECISION,
        ..Bank::default()
    };
    create_anchor_account_info!(bank, Bank, bank_account_info);
    let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

    let mut user = User {
        positions: get_positions(MarketPosition {
            market_index: 0,
            quote_asset_amount: 100 * QUOTE_PRECISION_I128,
            ..MarketPosition::default()
        }),
        bank_balances: get_bank_balances(UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 100 * BANK_INTEREST_PRECISION,
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.positions[0].quote_asset_amount = 50 * QUOTE_PRECISION_I128;
    expected_user.positions[0].realized_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.bank_balances[0].balance = 150 * BANK_INTEREST_PRECISION;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 0;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &bank_map,
        &mut oracle_map,
        now,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_unsettled_positive_pnl_less_than_pool() {
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
        pnl_pool: PoolBalance {
            balance: 50 * BANK_INTEREST_PRECISION,
        },
        unrealized_maintenance_asset_weight: cast(BANK_WEIGHT_PRECISION).unwrap(),
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
        deposit_balance: 100 * BANK_INTEREST_PRECISION,
        ..Bank::default()
    };
    create_anchor_account_info!(bank, Bank, bank_account_info);
    let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

    let mut user = User {
        positions: get_positions(MarketPosition {
            market_index: 0,
            quote_asset_amount: 25 * QUOTE_PRECISION_I128,
            ..MarketPosition::default()
        }),
        bank_balances: get_bank_balances(UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 100 * BANK_INTEREST_PRECISION,
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.positions[0].quote_asset_amount = 0;
    expected_user.positions[0].realized_pnl = 25 * QUOTE_PRECISION_I64;
    expected_user.bank_balances[0].balance = 125 * BANK_INTEREST_PRECISION;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 24999999;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &bank_map,
        &mut oracle_map,
        now,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn market_fee_pool_receives_portion() {
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
            total_fee_minus_distributions: QUOTE_PRECISION_I128,
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        initialized: true,
        liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: 50 * BANK_INTEREST_PRECISION,
        },
        unrealized_maintenance_asset_weight: cast(BANK_WEIGHT_PRECISION).unwrap(),
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
        deposit_balance: 100 * BANK_INTEREST_PRECISION,
        ..Bank::default()
    };
    create_anchor_account_info!(bank, Bank, bank_account_info);
    let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

    let mut user = User {
        positions: get_positions(MarketPosition {
            market_index: 0,
            quote_asset_amount: -100 * QUOTE_PRECISION_I128,
            ..MarketPosition::default()
        }),
        bank_balances: get_bank_balances(UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 200 * BANK_INTEREST_PRECISION,
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.positions[0].quote_asset_amount = 0;
    expected_user.positions[0].realized_pnl = -100 * QUOTE_PRECISION_I64;
    expected_user.bank_balances[0].balance = 99999999;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 149 * BANK_INTEREST_PRECISION;
    expected_market.amm.fee_pool.balance = BANK_INTEREST_PRECISION;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &bank_map,
        &mut oracle_map,
        now,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn market_fee_pool_pays_back_to_pnl_pool() {
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
            total_fee_minus_distributions: QUOTE_PRECISION_I128,
            fee_pool: PoolBalance {
                balance: 2 * BANK_INTEREST_PRECISION,
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        initialized: true,
        liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: 50 * BANK_INTEREST_PRECISION,
        },
        unrealized_maintenance_asset_weight: cast(BANK_WEIGHT_PRECISION).unwrap(),
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
        deposit_balance: 100 * BANK_INTEREST_PRECISION,
        ..Bank::default()
    };
    create_anchor_account_info!(bank, Bank, bank_account_info);
    let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

    let mut user = User {
        positions: get_positions(MarketPosition {
            market_index: 0,
            quote_asset_amount: -100 * QUOTE_PRECISION_I128,
            ..MarketPosition::default()
        }),
        bank_balances: get_bank_balances(UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 200 * BANK_INTEREST_PRECISION,
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.positions[0].quote_asset_amount = 0;
    expected_user.positions[0].realized_pnl = -100 * QUOTE_PRECISION_I64;
    expected_user.bank_balances[0].balance = 99999999;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 151 * BANK_INTEREST_PRECISION;
    expected_market.amm.fee_pool.balance = 999999;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &bank_map,
        &mut oracle_map,
        now,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_long_positive_unrealized_pnl_up_to_max_positive_pnl() {
    let now = 0_i64;
    let slot = 0_u64;

    let mut oracle_price = get_pyth_price(150, 10);
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
        pnl_pool: PoolBalance {
            balance: 50 * BANK_INTEREST_PRECISION,
        },
        unrealized_maintenance_asset_weight: cast(BANK_WEIGHT_PRECISION).unwrap(),
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
        deposit_balance: 100 * BANK_INTEREST_PRECISION,
        ..Bank::default()
    };
    create_anchor_account_info!(bank, Bank, bank_account_info);
    let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

    let mut user = User {
        positions: get_positions(MarketPosition {
            market_index: 0,
            base_asset_amount: BASE_PRECISION_I128,
            quote_asset_amount: -50 * QUOTE_PRECISION_I128,
            quote_entry_amount: -100 * QUOTE_PRECISION_I128,
            ..MarketPosition::default()
        }),
        bank_balances: get_bank_balances(UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 100 * BANK_INTEREST_PRECISION,
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.positions[0].quote_asset_amount = -100 * QUOTE_PRECISION_I128;
    expected_user.positions[0].realized_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.bank_balances[0].balance = 150 * BANK_INTEREST_PRECISION;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 0;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &bank_map,
        &mut oracle_map,
        now,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_long_negative_unrealized_pnl() {
    let now = 0_i64;
    let slot = 0_u64;

    let mut oracle_price = get_pyth_price(50, 10);
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
        pnl_pool: PoolBalance {
            balance: 50 * BANK_INTEREST_PRECISION,
        },
        unrealized_maintenance_asset_weight: cast(BANK_WEIGHT_PRECISION).unwrap(),
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
        deposit_balance: 100 * BANK_INTEREST_PRECISION,
        ..Bank::default()
    };
    create_anchor_account_info!(bank, Bank, bank_account_info);
    let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

    let mut user = User {
        positions: get_positions(MarketPosition {
            market_index: 0,
            base_asset_amount: BASE_PRECISION_I128,
            quote_asset_amount: -100 * QUOTE_PRECISION_I128,
            quote_entry_amount: -100 * QUOTE_PRECISION_I128,
            ..MarketPosition::default()
        }),
        bank_balances: get_bank_balances(UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 100 * BANK_INTEREST_PRECISION,
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.positions[0].quote_asset_amount = -50 * QUOTE_PRECISION_I128;
    expected_user.positions[0].realized_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.bank_balances[0].balance = 49999999;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 100 * BANK_INTEREST_PRECISION;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &bank_map,
        &mut oracle_map,
        now,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_short_positive_unrealized_pnl_up_to_max_positive_pnl() {
    let now = 0_i64;
    let slot = 0_u64;

    let mut oracle_price = get_pyth_price(50, 10);
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
        pnl_pool: PoolBalance {
            balance: 50 * BANK_INTEREST_PRECISION,
        },
        unrealized_maintenance_asset_weight: cast(BANK_WEIGHT_PRECISION).unwrap(),
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
        deposit_balance: 100 * BANK_INTEREST_PRECISION,
        ..Bank::default()
    };
    create_anchor_account_info!(bank, Bank, bank_account_info);
    let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

    let mut user = User {
        positions: get_positions(MarketPosition {
            market_index: 0,
            base_asset_amount: -BASE_PRECISION_I128,
            quote_asset_amount: 100 * QUOTE_PRECISION_I128,
            quote_entry_amount: 50 * QUOTE_PRECISION_I128,
            ..MarketPosition::default()
        }),
        bank_balances: get_bank_balances(UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 100 * BANK_INTEREST_PRECISION,
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.positions[0].quote_asset_amount = 50 * QUOTE_PRECISION_I128;
    expected_user.positions[0].realized_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.bank_balances[0].balance = 150 * BANK_INTEREST_PRECISION;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 0;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &bank_map,
        &mut oracle_map,
        now,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_short_negative_unrealized_pnl() {
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
        pnl_pool: PoolBalance {
            balance: 50 * BANK_INTEREST_PRECISION,
        },
        unrealized_maintenance_asset_weight: cast(BANK_WEIGHT_PRECISION).unwrap(),
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
        deposit_balance: 100 * BANK_INTEREST_PRECISION,
        ..Bank::default()
    };
    create_anchor_account_info!(bank, Bank, bank_account_info);
    let bank_map = BankMap::load_one(&bank_account_info, true).unwrap();

    let mut user = User {
        positions: get_positions(MarketPosition {
            market_index: 0,
            base_asset_amount: -BASE_PRECISION_I128,
            quote_asset_amount: 50 * QUOTE_PRECISION_I128,
            quote_entry_amount: 50 * QUOTE_PRECISION_I128,
            ..MarketPosition::default()
        }),
        bank_balances: get_bank_balances(UserBankBalance {
            bank_index: 0,
            balance_type: BankBalanceType::Deposit,
            balance: 100 * BANK_INTEREST_PRECISION,
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.positions[0].quote_asset_amount = 100 * QUOTE_PRECISION_I128;
    expected_user.positions[0].realized_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.bank_balances[0].balance = 49999999;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 100 * BANK_INTEREST_PRECISION;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &bank_map,
        &mut oracle_map,
        now,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}
