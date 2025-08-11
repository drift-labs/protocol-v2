use std::str::FromStr;

use anchor_lang::Owner;
use solana_program::pubkey::Pubkey;

use crate::controller::pnl::settle_pnl;
use crate::error::ErrorCode;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BASE_PRECISION_I64, LIQUIDATION_FEE_PRECISION,
    PEG_PRECISION, QUOTE_PRECISION_I128, QUOTE_PRECISION_I64, QUOTE_SPOT_MARKET_INDEX,
    SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION,
    SPOT_WEIGHT_PRECISION,
};
use crate::math::margin::{
    meets_maintenance_margin_requirement, meets_settle_pnl_maintenance_margin_requirement,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::state::oracle::{HistoricalOracleData, OracleSource};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{MarketStatus, PerpMarket, PoolBalance, AMM};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::{OracleGuardRails, State, ValidityGuardRails};
use crate::state::user::{PerpPosition, SpotPosition, User};
use crate::{test_utils::*, FUNDING_RATE_PRECISION_I128, PERCENTAGE_PRECISION, PERCENTAGE_PRECISION_I128};
use crate::test_utils::{get_positions, get_pyth_price, get_spot_positions};
use crate::{create_account_info, SettlePnlMode};
use crate::{create_anchor_account_info, PRICE_PRECISION_I64};
use anchor_lang::prelude::{AccountLoader, Clock};

use crate::controller::amm::update_pool_balances;

#[test]
pub fn user_settle_pnl_e() {
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };

    let market_index = 2;
    let perp_market_str = String::from("Ct8MLGv1N/cP8V8Fb1epGNxhYovgt6QslGhUT6HV1zTpfCkrkbwLkndwx9kOHTTRdsq6+h4yZlyZWL2p6k8cVCwzZ4FGbCUqrtoZAAEAAAAAAAAAAAAAAAAAAAAAAAAA2BNCAAEAAACu0f7/AAAAAKk8mmgAAAAAPdV3AgAAAAAAAAAAAAAAAMZVogoAAAAAAAAAAAAAAACxmhG3M40FAAAAAAAAAAAAAAAAAAAAAACRd8X7JpsEAAAAAAAAAAAAza8BXOmaBAAAAAAAAAAAAFdKDwAAAAAAAAAAAAAAAADziVIDaZgEAAAAAAAAAAAAdpCttkmdBAAAAAAAAAAAADCCfCsImwQAAAAAAAAAAAC6PScAAQAAAAAAAAAAAAAAyh04oTebBAAAAAAAAAAAAIBOStUsCAAAAAAAAAAAAADAZAMBhff/////////////XWzku7H//////////////+NGaRoAAAAAAAAAAAAAAAAAID2IeS0AAAAAAAAAAAAAvO/pd3YCAAAAAAAAAAAAABpRjmDq4P////////////894ULZxB0AAAAAAAAAAAAA6GSxvsPg/////////////4PIQjoKHgAAAAAAAAAAAAAAkE8MyAAAAAAAAAAAAAAADijQAQAAAAAOKNABAAAAAA4o0AEAAAAAo0J+BQAAAACCgYeOvgMAAAAAAAAAAAAAXLQGiIYCAAAAAAAAAAAAAOlpgMc8AQAAAAAAAAAAAABlUVvpIwIAAAAAAAAAAAAA3HiBoDABAAAAAAAAAAAAABPobKXaAAAAAAAAAAAAAADXtByHBgEAAAAAAAAAAAAAbHHYhAYBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiUKF38poEAAAAAAAAAAAAiPq93x2bBAAAAAAAAAAAALktd/axmwQAAAAAAAAAAABtBPJ4XpoEAAAAAAAAAAAArtoZAAEAAAAAAAAAAAAAAK9JLwABAAAAPgpJAAEAAAD2KTwAAQAAAMU0+v8AAAAAqf9rFQAAAADCAAAAAAAAAF/0CisAAAAAoy+aaAAAAAAQDgAAAAAAAEBCDwAAAAAAECcAAAAAAABAQg8AAAAAAAAAAAAAAAAA4UhJ2eq7AAASNErVNgIAAGyIcns1AwAAqTyaaAAAAAAhIUIAAAAAACo5KAAAAAAAqTyaaAAAAACvAAAA6AMAAFwBAACYAwAAAAAAAAAAAADcBTIAZAAMAcCmjPgABWT/AAAAAAAAAAB0a7Fc/v///wi4kMX/////AAAAAGQAAAB5uLoAAQAAAGnLGSFYIwEAAAAAAAAAAAAAAAAAAAAAAEVUSC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAA4fUFAAAAAP8PpdToAAAAraHj0QwAAACGE5poAAAAAADh9QUAAAAAAAAAAAAAAAAAAAAAAAAAAAEMSwAAAAAAHFsAAAAAAABXCwAAAAAAAPoAAAAAAAAAiBMAAEwdAAD0AQAALAEAAAAAAAAQJwAAQwQAACYEAAACAAEAAQgAAJz/AAAAAGMAQgAAAAAAAAAgF/r/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::default();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

    let perp_market_loader: AccountLoader<PerpMarket> =
        AccountLoader::try_from(&perp_market_account_info).unwrap();

    let perp_market_map = PerpMarketMap::load_one(&perp_market_account_info, true).unwrap();
    {
        let mut perp_market = perp_market_map.get_ref_mut(&market_index).unwrap();
        perp_market.amm.oracle_source = OracleSource::Pyth;
        perp_market.paused_operations = 0;
        // assert_eq!(perp_market.expiry_ts, 1725559200);
    }

    let now = 1754938689;
    let clock_slot = 359409740;
    let clock = Clock {
        unix_timestamp: now,
        slot: clock_slot,
        ..Clock::default()
    };

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 80_000_000 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap_5min: PRICE_PRECISION_I64,
            ..HistoricalOracleData::default_price(QUOTE_PRECISION_I64)
        },
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 2,
            quote_asset_amount: 50000 * QUOTE_PRECISION_I64,
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

    let user_key = Pubkey::default();
    let authority = Pubkey::default();
    let mut oracle_price = get_pyth_price(4300, 6);
    let oracle_price_key =
        Pubkey::from_str("93FG52TzNKCnMiasV14Ba34BYcHDb9p4zK4GjZnLwqWR").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    {
        let mut perp_market = perp_market_map.get_ref_mut(&market_index).unwrap();
        assert_eq!(perp_market.pnl_pool.scaled_balance, 320336396143465);
        let pnl_pool_token_amount = get_token_amount(
            perp_market.pnl_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let fee_pool_token_amount = get_token_amount(
            perp_market.amm.fee_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let pnl_tokens_available: i128 = pnl_pool_token_amount
            .safe_add(fee_pool_token_amount)
            .unwrap()
            .cast()
            .unwrap();

        assert_eq!(pnl_tokens_available, 1882964533929); // 1.8M
        assert_eq!(perp_market.insurance_claim.revenue_withdraw_since_last_settle, 0);

        // assert_eq!(perp_market.expiry_ts, 1725559200);
    }

    let result = settle_pnl(
        2,
        &mut user,
        &authority,
        &user_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    ).unwrap();

    {
        let mut perp_market = perp_market_map.get_ref_mut(&market_index).unwrap();

        let pnl_pool_token_amount = get_token_amount(
            perp_market.pnl_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let fee_pool_token_amount = get_token_amount(
            perp_market.amm.fee_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let pnl_tokens_available: i128 = pnl_pool_token_amount
            .safe_add(fee_pool_token_amount)
            .unwrap()
            .cast()
            .unwrap();

        assert_eq!(pnl_tokens_available, 1832864533929);
        assert_eq!(perp_market.insurance_claim.revenue_withdraw_since_last_settle, -100000000);
    }

    let mut user2 = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 2,
            quote_asset_amount: 50000 * QUOTE_PRECISION_I64,
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

    let result = settle_pnl(
        2,
        &mut user2,
        &authority,
        &user_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    ).unwrap();


    {
        let mut perp_market = perp_market_map.get_ref_mut(&market_index).unwrap();

        let pnl_pool_token_amount = get_token_amount(
            perp_market.pnl_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let fee_pool_token_amount = get_token_amount(
            perp_market.amm.fee_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let pnl_tokens_available: i128 = pnl_pool_token_amount
            .safe_add(fee_pool_token_amount)
            .unwrap()
            .cast()
            .unwrap();

        assert_eq!(pnl_pool_token_amount, 220336396143);
        assert_eq!(pnl_tokens_available, 1782864533929);
        assert_eq!(perp_market.insurance_claim.revenue_withdraw_since_last_settle, -100000000);
    }


        let mut user3 = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 2,
            base_asset_amount: 1_000_000_000,
            quote_asset_amount: 350_000 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let result = settle_pnl(
        2,
        &mut user3,
        &authority,
        &user_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    ).unwrap();


    {
        let mut perp_market = perp_market_map.get_ref_mut(&market_index).unwrap();

        let pnl_pool_token_amount = get_token_amount(
            perp_market.pnl_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let fee_pool_token_amount = get_token_amount(
            perp_market.amm.fee_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let pnl_tokens_available: i128 = pnl_pool_token_amount
            .safe_add(fee_pool_token_amount)
            .unwrap()
            .cast()
            .unwrap();

        assert_eq!(pnl_pool_token_amount, 0);
        assert_eq!(pnl_tokens_available, 1562528137786);
        assert_eq!(perp_market.insurance_claim.revenue_withdraw_since_last_settle, -100000000);
    }
}

#[test]
pub fn user_settle_pnl_e_crisp() {
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };

    let market_index = 2;
    let perp_market_str = String::from("Ct8MLGv1N/cP8V8Fb1epGNxhYovgt6QslGhUT6HV1zTpfCkrkbwLkndwx9kOHTTRdsq6+h4yZlyZWL2p6k8cVCwzZ4FGbCUqrtoZAAEAAAAAAAAAAAAAAAAAAAAAAAAA2BNCAAEAAACu0f7/AAAAAKk8mmgAAAAAPdV3AgAAAAAAAAAAAAAAAMZVogoAAAAAAAAAAAAAAACxmhG3M40FAAAAAAAAAAAAAAAAAAAAAACRd8X7JpsEAAAAAAAAAAAAza8BXOmaBAAAAAAAAAAAAFdKDwAAAAAAAAAAAAAAAADziVIDaZgEAAAAAAAAAAAAdpCttkmdBAAAAAAAAAAAADCCfCsImwQAAAAAAAAAAAC6PScAAQAAAAAAAAAAAAAAyh04oTebBAAAAAAAAAAAAIBOStUsCAAAAAAAAAAAAADAZAMBhff/////////////XWzku7H//////////////+NGaRoAAAAAAAAAAAAAAAAAID2IeS0AAAAAAAAAAAAAvO/pd3YCAAAAAAAAAAAAABpRjmDq4P////////////894ULZxB0AAAAAAAAAAAAA6GSxvsPg/////////////4PIQjoKHgAAAAAAAAAAAAAAkE8MyAAAAAAAAAAAAAAADijQAQAAAAAOKNABAAAAAA4o0AEAAAAAo0J+BQAAAACCgYeOvgMAAAAAAAAAAAAAXLQGiIYCAAAAAAAAAAAAAOlpgMc8AQAAAAAAAAAAAABlUVvpIwIAAAAAAAAAAAAA3HiBoDABAAAAAAAAAAAAABPobKXaAAAAAAAAAAAAAADXtByHBgEAAAAAAAAAAAAAbHHYhAYBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiUKF38poEAAAAAAAAAAAAiPq93x2bBAAAAAAAAAAAALktd/axmwQAAAAAAAAAAABtBPJ4XpoEAAAAAAAAAAAArtoZAAEAAAAAAAAAAAAAAK9JLwABAAAAPgpJAAEAAAD2KTwAAQAAAMU0+v8AAAAAqf9rFQAAAADCAAAAAAAAAF/0CisAAAAAoy+aaAAAAAAQDgAAAAAAAEBCDwAAAAAAECcAAAAAAABAQg8AAAAAAAAAAAAAAAAA4UhJ2eq7AAASNErVNgIAAGyIcns1AwAAqTyaaAAAAAAhIUIAAAAAACo5KAAAAAAAqTyaaAAAAACvAAAA6AMAAFwBAACYAwAAAAAAAAAAAADcBTIAZAAMAcCmjPgABWT/AAAAAAAAAAB0a7Fc/v///wi4kMX/////AAAAAGQAAAB5uLoAAQAAAGnLGSFYIwEAAAAAAAAAAAAAAAAAAAAAAEVUSC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAA4fUFAAAAAP8PpdToAAAAraHj0QwAAACGE5poAAAAAADh9QUAAAAAAAAAAAAAAAAAAAAAAAAAAAEMSwAAAAAAHFsAAAAAAABXCwAAAAAAAPoAAAAAAAAAiBMAAEwdAAD0AQAALAEAAAAAAAAQJwAAQwQAACYEAAACAAEAAQgAAJz/AAAAAGMAQgAAAAAAAAAgF/r/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::default();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

    let perp_market_loader: AccountLoader<PerpMarket> =
        AccountLoader::try_from(&perp_market_account_info).unwrap();

    let perp_market_map = PerpMarketMap::load_one(&perp_market_account_info, true).unwrap();
    {
        let mut perp_market = perp_market_map.get_ref_mut(&market_index).unwrap();
        
        // Set AMM properties
        // Set market-level properties
        perp_market.number_of_users_with_base = 1092;
        perp_market.number_of_users = 1057;
        perp_market.market_index = 2;
        perp_market.status = MarketStatus::Active;
        perp_market.contract_type = crate::state::perp_market::ContractType::Perpetual;
        perp_market.contract_tier = crate::state::perp_market::ContractTier::B;
        perp_market.paused_operations = 8;
        perp_market.quote_spot_market_index = 0;
        perp_market.fee_adjustment = -100;
        perp_market.fuel_boost_position = 0;
        perp_market.fuel_boost_taker = 0;
        perp_market.fuel_boost_maker = 0;
        perp_market.pool_id = 0;
        perp_market.high_leverage_margin_ratio_initial = 99;
        perp_market.high_leverage_margin_ratio_maintenance = 66;
        perp_market.protected_maker_limit_price_divisor = 0;
        perp_market.protected_maker_dynamic_divisor = 0;
        perp_market.last_fill_price = 4286200000;
        
        // Set AMM properties
        perp_market.amm.oracle = Pubkey::from_str("93FG52TzNKCnMiasV14Ba34BYcHDb9p4zK4GjZnLwqWR").unwrap();
        perp_market.amm.base_asset_amount_per_lp = 41407804 * QUOTE_PRECISION_I128;
        perp_market.amm.quote_asset_amount_per_lp = 178410957 * QUOTE_PRECISION_I128;
        perp_market.amm.base_asset_reserve = ((1296491.64 * AMM_RESERVE_PRECISION as f64) as u128);
        perp_market.amm.quote_asset_reserve = ((1296226.971 * AMM_RESERVE_PRECISION as f64) as u128);
        perp_market.amm.concentration_coef = ((1.002071 * PERCENTAGE_PRECISION as f64) as u128);
        perp_market.amm.min_base_asset_reserve = ((1293476.702 * AMM_RESERVE_PRECISION as f64) as u128);
        perp_market.amm.max_base_asset_reserve = ((1298839.83 * AMM_RESERVE_PRECISION as f64) as u128);
        perp_market.amm.sqrt_k = ((1296359.298 * AMM_RESERVE_PRECISION as f64) as u128);
        perp_market.amm.peg_multiplier = ((4288.169684 * PEG_PRECISION as f64) as u128);
        perp_market.amm.terminal_quote_asset_reserve = ((1296563.137 * AMM_RESERVE_PRECISION as f64) as u128);
        perp_market.amm.base_asset_amount_long = ((8992.406 * QUOTE_PRECISION_I128 as f64) as i128);
        perp_market.amm.base_asset_amount_short = ((-9328.165 * QUOTE_PRECISION_I128 as f64) as i128);
        perp_market.amm.base_asset_amount_with_amm = ((-336.1481079 * QUOTE_PRECISION_I128 as f64) as i128);
        perp_market.amm.base_asset_amount_with_unsettled_lp = ((0.389107902 * QUOTE_PRECISION_I128 as f64) as i128);
        perp_market.amm.max_open_interest = 50000 * QUOTE_PRECISION_I128 as u128;
        perp_market.amm.quote_asset_amount = ((2612393.373 * QUOTE_PRECISION_I128 as f64) as i128);
        perp_market.amm.quote_entry_amount_long = ((-34194450.81 * QUOTE_PRECISION_I128 as f64) as i128);
        perp_market.amm.quote_entry_amount_short = ((32734956.69 * QUOTE_PRECISION_I128 as f64) as i128);
        perp_market.amm.quote_break_even_amount_long = ((-34360414.32 * QUOTE_PRECISION_I128 as f64) as i128);
        perp_market.amm.quote_break_even_amount_short = ((33027633.76 * QUOTE_PRECISION_I128 as f64) as i128);
        perp_market.amm.user_lp_shares = ((859.2 * QUOTE_PRECISION_I128 as f64) as u128);
        perp_market.amm.last_funding_rate = ((0.030418958 * FUNDING_RATE_PRECISION_I128 as f64) as i64);
        perp_market.amm.last_funding_rate_long = ((0.030418958 * FUNDING_RATE_PRECISION_I128 as f64) as i64);
        perp_market.amm.last_funding_rate_short = ((0.030418958 * FUNDING_RATE_PRECISION_I128 as f64) as i64);
        perp_market.amm.last_24h_avg_funding_rate = ((0.092160675 * FUNDING_RATE_PRECISION_I128 as f64) as i64);
        perp_market.amm.total_fee = ((4116969.854 * QUOTE_PRECISION_I128 as f64) as i128);
        perp_market.amm.total_mm_fee = ((2776830.954 * QUOTE_PRECISION_I128 as f64) as i128);
        perp_market.amm.total_exchange_fee = ((1360556.747 * QUOTE_PRECISION_I128 as f64) as u128);
        perp_market.amm.total_fee_minus_distributions = ((2350112.432 * QUOTE_PRECISION_I128 as f64) as i128);
        perp_market.amm.total_fee_withdrawn = ((1308362.898 * QUOTE_PRECISION_I128 as f64) as u128);
        perp_market.amm.total_liquidation_fee = ((939078.2485 * QUOTE_PRECISION_I128 as f64) as u128);
        perp_market.amm.cumulative_funding_rate_long = ((1127.548237 * FUNDING_RATE_PRECISION_I128 as f64) as i128);
        perp_market.amm.cumulative_funding_rate_short = ((1127.510209 * FUNDING_RATE_PRECISION_I128 as f64) as i128);
        perp_market.amm.total_social_loss = 0;
        perp_market.amm.ask_base_asset_reserve = ((1295701.096 * AMM_RESERVE_PRECISION as f64) as u128);
        perp_market.amm.ask_quote_asset_reserve = ((1297017.835 * AMM_RESERVE_PRECISION as f64) as u128);
        perp_market.amm.bid_base_asset_reserve = ((1299478.948 * AMM_RESERVE_PRECISION as f64) as u128);
        perp_market.amm.bid_quote_asset_reserve = ((1293247.138 * AMM_RESERVE_PRECISION as f64) as u128);
        perp_market.amm.last_oracle_normalised_price = ((4287.294286 * PRICE_PRECISION_I64 as f64) as i64);
        perp_market.amm.last_oracle_reserve_price_spread_pct = 0;
        perp_market.amm.last_bid_price_twap = ((4304.923047 * PRICE_PRECISION_I64 as f64) as u64);
        perp_market.amm.last_ask_price_twap = ((4306.813377 * PRICE_PRECISION_I64 as f64) as u64);
        perp_market.amm.last_mark_price_twap = ((4305.868212 * PRICE_PRECISION_I64 as f64) as u64);
        perp_market.amm.last_mark_price_twap_5min = ((4291.181839 * PRICE_PRECISION_I64 as f64) as u64);
        perp_market.amm.last_update_slot = 359391364;
        perp_market.amm.last_oracle_conf_pct = ((7.90E-05 * PERCENTAGE_PRECISION_I128 as f64) as u64);
        perp_market.amm.net_revenue_since_last_funding = ((-2427.616666 * QUOTE_PRECISION_I128 as f64) as i64);
        perp_market.amm.last_funding_rate_ts = 1754935203;
        perp_market.amm.funding_period = 3600;
        perp_market.amm.order_step_size = ((0.001 * BASE_PRECISION_I128 as f64) as u64);
        perp_market.amm.mm_oracle_slot = 0;
        perp_market.amm.last_trade_ts = 1754935203; // 8/11/25 18:03 converted to timestamp
        perp_market.amm.last_mark_price_twap_ts = 1754935203; // 8/11/25 18:03 converted to timestamp
        perp_market.amm.mm_oracle_price = 0;
        perp_market.amm.max_fill_reserve_fraction = 1500;
        perp_market.amm.max_slippage_ratio = 50;
        perp_market.amm.curve_update_intensity = 100;
        perp_market.amm.amm_jit_intensity = 0;
        perp_market.amm.oracle_source = OracleSource::PythLazer;
        perp_market.amm.last_oracle_valid = true;
        perp_market.amm.target_base_asset_amount_per_lp = -125000000;
        perp_market.amm.per_lp_base = 0;
        perp_market.amm.taker_speed_bump_override = 5;
        perp_market.amm.amm_spread_adjustment = 100;
        perp_market.amm.oracle_slot_delay_override = -1;
        perp_market.amm.mm_oracle_sequence_id = 0;
        perp_market.amm.net_unsettled_funding_pnl = ((-1340860777 * QUOTE_PRECISION_I128) as i64);
        perp_market.amm.quote_asset_amount_with_unsettled_lp = ((-748412855 * QUOTE_PRECISION_I128) as i64);
        perp_market.amm.reference_price_offset = 0;
        perp_market.amm.amm_inventory_spread_adjustment = 100;
        perp_market.amm.last_funding_oracle_twap = 4307204217;
        
        // Set historical oracle data
        perp_market.amm.historical_oracle_data.last_oracle_price = ((4287.294286 * PRICE_PRECISION_I64 as f64) as i64);
        perp_market.amm.historical_oracle_data.last_oracle_conf = 0;
        perp_market.amm.historical_oracle_data.last_oracle_delay = 0;
        perp_market.amm.historical_oracle_data.last_oracle_price_twap = ((4306.022639 * PRICE_PRECISION_I64 as f64) as i64);
        perp_market.amm.historical_oracle_data.last_oracle_price_twap_5min = ((4291.54186 * PRICE_PRECISION_I64 as f64) as i64);
        perp_market.amm.historical_oracle_data.last_oracle_price_twap_ts = 1754935203; // 8/11/25 18:03 converted to timestamp
        
        // Set fee pool
        perp_market.amm.fee_pool.scaled_balance = ((1561641.262 * SPOT_BALANCE_PRECISION as f64) as u128);
        perp_market.amm.fee_pool.market_index = 0;


        
        // Set insurance claim
        perp_market.insurance_claim.revenue_withdraw_since_last_settle = (-100 * QUOTE_PRECISION_I128) as i64;
        perp_market.insurance_claim.max_revenue_withdraw_per_period = (100 * QUOTE_PRECISION_I128) as u64;
        perp_market.insurance_claim.quote_max_insurance = (1000000 * QUOTE_PRECISION_I128) as u64;
        perp_market.insurance_claim.quote_settled_insurance = (55060 * QUOTE_PRECISION_I128) as u64;
        perp_market.insurance_claim.last_revenue_withdraw_ts = 1754928006;
        
        // Set pnl pool
        perp_market.pnl_pool.scaled_balance = ((258984.219 * SPOT_BALANCE_PRECISION as f64) as u128);
        perp_market.pnl_pool.market_index = 0;
        
        perp_market.amm.oracle_source = OracleSource::Pyth;
        perp_market.paused_operations = 0;
        // assert_eq!(perp_market.expiry_ts, 1725559200);
        // assert_eq!(perp_market.expiry_ts, 1725559200);
    }

    let now = 1754938689;
    let clock_slot = 359409740;
    let clock = Clock {
        unix_timestamp: now,
        slot: clock_slot,
        ..Clock::default()
    };

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: 11677971871,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 80_000_000 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap_5min: PRICE_PRECISION_I64,
            ..HistoricalOracleData::default_price(QUOTE_PRECISION_I64)
        },
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 2,
            quote_asset_amount: 50000 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();
    let mut oracle_price = get_pyth_price(4300, 6);
    let oracle_price_key =
        Pubkey::from_str("93FG52TzNKCnMiasV14Ba34BYcHDb9p4zK4GjZnLwqWR").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    {
        let mut perp_market = perp_market_map.get_ref_mut(&market_index).unwrap();
        let pnl_pool_token_amount = get_token_amount(
            perp_market.pnl_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let fee_pool_token_amount = get_token_amount(
            perp_market.amm.fee_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        println!("pnl_pool_token_amount: {}", pnl_pool_token_amount);
        println!("fee_pool_token_amount: {}", fee_pool_token_amount);

    }

    {
        let mut perp_market = perp_market_map.get_ref_mut(&market_index).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            -11694947484,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            -22802376,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            -40697916,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            15277796162,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            -143027021,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            3225410,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            -36904956066,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            -32320580739,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            -34001385475,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            6115374062,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            210186,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            111529643,
            now,
        ).unwrap();
        
        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            11504604,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            3459985251,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            -115351632,
            now,
        ).unwrap();

        update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &user.get_quote_spot_position(),
            286748623,
            now,
        ).unwrap();

        let pnl_pool_token_amount = get_token_amount(
            perp_market.pnl_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        let fee_pool_token_amount = get_token_amount(
            perp_market.amm.fee_pool.scaled_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        println!("pnl_pool_token_amount: {}", pnl_pool_token_amount);
        println!("fee_pool_token_amount: {}", fee_pool_token_amount);
    }

    assert_eq!(true, false);
    // {
    //     let mut perp_market = perp_market_map.get_ref_mut(&market_index).unwrap();

    //     update_pool_balances(
    //         &mut perp_market,
    //         &mut spot_market,
    //         &user.get_quote_spot_position(),
    //         -286748623,
    //         now,
    //     ).unwrap();

    //     update_pool_balances(
    //         &mut perp_market,
    //         &mut spot_market,
    //         &user.get_quote_spot_position(),
    //         115351632,
    //         now,
    //     ).unwrap();


    //     update_pool_balances(
    //         &mut perp_market,
    //         &mut spot_market,
    //         &user.get_quote_spot_position(),
    //         -3459985251,
    //         now,
    //     ).unwrap();

    //     let pnl_pool_token_amount = get_token_amount(
    //         perp_market.pnl_pool.scaled_balance,
    //         &spot_market,
    //         &SpotBalanceType::Deposit,
    //     )
    //     .unwrap();

    //     println!("pnl_pool_token_amount: {}", pnl_pool_token_amount);
    // }
}

#[test]
pub fn user_no_position() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
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
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: [PerpPosition::default(); 8],
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
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
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );

    assert_eq!(result, Err(ErrorCode::UserHasNoPositionInMarket));
}

#[test]
pub fn user_does_not_meet_maintenance_requirement() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
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
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
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
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: -120 * QUOTE_PRECISION_I64,
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

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );

    assert_eq!(result, Err(ErrorCode::InsufficientCollateralForSettlingPNL))
}

#[test]
pub fn user_does_not_meet_strict_maintenance_requirement() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
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
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
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
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap_5min: PRICE_PRECISION_I64 / 2,
            ..HistoricalOracleData::default_price(QUOTE_PRECISION_I64)
        },
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: -51 * QUOTE_PRECISION_I64,
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

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );

    assert_eq!(result, Err(ErrorCode::InsufficientCollateralForSettlingPNL));

    let meets_maintenance =
        meets_maintenance_margin_requirement(&user, &market_map, &spot_market_map, &mut oracle_map)
            .unwrap();

    assert_eq!(meets_maintenance, true);

    let meets_settle_pnl_maintenance = meets_settle_pnl_maintenance_margin_requirement(
        &user,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
    )
    .unwrap();

    assert_eq!(meets_settle_pnl_maintenance, false);
}

#[test]
pub fn user_unsettled_negative_pnl() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
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
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        number_of_users: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
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
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: -50 * QUOTE_PRECISION_I64,
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

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 0;
    expected_user.settled_perp_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 50 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 100 * SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount = -100 * QUOTE_PRECISION_I128;
    expected_market.number_of_users = 0;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_unsettled_positive_pnl_more_than_pool() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
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
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
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
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: 100 * QUOTE_PRECISION_I64,
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

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 50 * QUOTE_PRECISION_I64;
    expected_user.settled_perp_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 150 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 0;
    expected_market.amm.quote_asset_amount = -200 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_unsettled_positive_pnl_less_than_pool() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
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
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        number_of_users: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
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
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: 25 * QUOTE_PRECISION_I64,
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

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 0;
    expected_user.settled_perp_pnl = 25 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 25 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 125 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 25 * SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount = -175 * QUOTE_PRECISION_I128;
    expected_market.number_of_users = 0;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn market_fee_pool_receives_portion() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let slot = clock.slot;
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
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
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            total_fee_minus_distributions: QUOTE_PRECISION_I128,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        number_of_users: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
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
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: -100 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 200 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 0;
    expected_user.settled_perp_pnl = -100 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = -100 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 100 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 149 * SPOT_BALANCE_PRECISION;
    expected_market.amm.fee_pool.scaled_balance = SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount = -50 * QUOTE_PRECISION_I128;
    expected_market.number_of_users = 0;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn market_fee_pool_pays_back_to_pnl_pool() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
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
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            total_fee_minus_distributions: QUOTE_PRECISION_I128,
            fee_pool: PoolBalance {
                scaled_balance: (2 * SPOT_BALANCE_PRECISION),
                market_index: QUOTE_SPOT_MARKET_INDEX,
                ..PoolBalance::default()
            },
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        number_of_users: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
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
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: -100 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 200 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 0;
    expected_user.settled_perp_pnl = -100 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = -100 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 100 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 151 * SPOT_BALANCE_PRECISION;
    expected_market.amm.fee_pool.scaled_balance = SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount = -50 * QUOTE_PRECISION_I128;
    expected_market.number_of_users = 0;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_long_positive_unrealized_pnl_up_to_max_positive_pnl() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
    let mut oracle_price = get_pyth_price(150, 6);
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
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 151 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
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
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: BASE_PRECISION_I64,
            quote_asset_amount: -50 * QUOTE_PRECISION_I64,
            quote_entry_amount: -100 * QUOTE_PRECISION_I64,
            quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
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

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = -100 * QUOTE_PRECISION_I64;
    expected_user.settled_perp_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 150 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 0;
    expected_market.amm.quote_asset_amount = -200 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_long_positive_unrealized_pnl_up_to_max_positive_pnl_price_breached() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
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
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 121 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
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
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: BASE_PRECISION_I64,
            quote_asset_amount: -50 * QUOTE_PRECISION_I64,
            quote_entry_amount: -100 * QUOTE_PRECISION_I64,
            quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
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

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = -100 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 150 * SPOT_BALANCE_PRECISION_U64;
    expected_user.spot_positions[0].cumulative_deposits = 50 * QUOTE_PRECISION_I64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 0;
    expected_market.amm.quote_asset_amount = -200 * QUOTE_PRECISION_I128;

    assert!(settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle
    )
    .is_err());
}

#[test]
pub fn user_long_negative_unrealized_pnl() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
    let mut oracle_price = get_pyth_price(50, 6);
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
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 51 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
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
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: BASE_PRECISION_I64,
            quote_asset_amount: -100 * QUOTE_PRECISION_I64,
            quote_entry_amount: -100 * QUOTE_PRECISION_I64,
            quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
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

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = -50 * QUOTE_PRECISION_I64;
    expected_user.settled_perp_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 50 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 100 * SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount = -100 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_short_positive_unrealized_pnl_up_to_max_positive_pnl() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
    let mut oracle_price = get_pyth_price(50, 6);
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
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 51 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: 150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
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
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: -BASE_PRECISION_I64,
            quote_asset_amount: 100 * QUOTE_PRECISION_I64,
            quote_entry_amount: 50 * QUOTE_PRECISION_I64,
            quote_break_even_amount: 50 * QUOTE_PRECISION_I64,
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

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 50 * QUOTE_PRECISION_I64;
    expected_user.settled_perp_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 150 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 0;
    expected_market.amm.quote_asset_amount = 100 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_short_negative_unrealized_pnl() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
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
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: 150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
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
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: -BASE_PRECISION_I64,
            quote_asset_amount: 50 * QUOTE_PRECISION_I64,
            quote_entry_amount: 50 * QUOTE_PRECISION_I64,
            quote_break_even_amount: 50 * QUOTE_PRECISION_I64,
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

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 100 * QUOTE_PRECISION_I64;
    expected_user.settled_perp_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 50 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 100 * SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount = 200 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_invalid_oracle_position() {
    let clock = Clock {
        slot: 100000,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 19929299,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
    let mut oracle_price = get_pyth_price(100, 6);
    oracle_price.curr_slot = clock.slot - 10;
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
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: 150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            curve_update_intensity: 100,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: -BASE_PRECISION_I64,
            quote_asset_amount: 50 * QUOTE_PRECISION_I64,
            quote_entry_amount: 50 * QUOTE_PRECISION_I64,
            quote_break_even_amount: 50 * QUOTE_PRECISION_I64,
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

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min -= market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min
        / 33;
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();
    assert!(!market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );
    assert_eq!(result, Err(ErrorCode::OracleStaleForMargin));

    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min /= 2;
    market.amm.last_update_slot = clock.slot;
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();
    assert!(!market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );
    assert_eq!(result, Err(ErrorCode::PriceBandsBreached));

    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min *= 4;
    market.amm.last_update_slot = clock.slot;
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();
    assert!(!market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );
    assert_eq!(result, Err(ErrorCode::PriceBandsBreached));

    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min = oracle_price.agg.price * 95 / 100;
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();
    assert!(!market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );
    assert_eq!(result, Err(ErrorCode::OracleStaleForMargin));

    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min = oracle_price.agg.price - 789789;
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    assert!(market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());
    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );
    assert_eq!(result, Ok(()));
}

#[test]
pub fn is_price_divergence_ok_on_invalid_oracle() {
    let clock = Clock {
        slot: 100000,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 19929299,
    };

    let mut oracle_price = get_pyth_price(100, 6);
    oracle_price.curr_slot = clock.slot - 10;
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();

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
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: 150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };

    assert!(market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    market.amm.mark_std = (oracle_price.agg.price / 100) as u64;
    market.amm.oracle_std = (oracle_price.agg.price / 190) as u64;

    assert!(market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    market.amm.mark_std = (oracle_price.agg.price / 10) as u64;

    assert!(!market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    market.amm.oracle_std = (oracle_price.agg.price * 10) as u64;

    assert!(!market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());
}
