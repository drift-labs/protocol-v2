#[cfg(test)]
mod test {
    use crate::amm::calculate_swap_output;
    use crate::controller::amm::SwapDirection;
    use crate::math::collateral::calculate_updated_collateral;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, PRICE_PRECISION, QUOTE_PRECISION, QUOTE_PRECISION_I64,
        SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_IMF_PRECISION,
    };
    use crate::math::margin::{
        calculate_perp_position_value_and_pnl, calculate_spot_position_value, MarginRequirementType,
    };
    use crate::math::position::{
        calculate_base_asset_value_and_pnl_with_oracle_price, calculate_position_pnl,
    };
    use crate::state::market::{PerpMarket, AMM};
    use crate::state::oracle::OraclePriceData;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::user::{PerpPosition, SpotPosition, User};
    use num_integer::Roots;

    #[test]
    fn spot_market_asset_weight() {
        let mut spot_market = SpotMarket {
            initial_asset_weight: 9000,
            initial_liability_weight: 11000,
            decimals: 6,
            imf_factor: 0,
            ..SpotMarket::default()
        };

        let size = 1000 * QUOTE_PRECISION;
        let asset_weight = spot_market
            .get_asset_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(asset_weight, 9000);

        let lib_weight = spot_market
            .get_liability_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(lib_weight, 11000);

        spot_market.imf_factor = 10;
        let asset_weight = spot_market
            .get_asset_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(asset_weight, 9000);

        let lib_weight = spot_market
            .get_liability_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(lib_weight, 11003);

        let same_asset_weight_diff_imf_factor = 8357;
        let asset_weight = spot_market
            .get_asset_weight(size * 1_000_000, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(asset_weight, same_asset_weight_diff_imf_factor);

        spot_market.imf_factor = 10000;
        let asset_weight = spot_market
            .get_asset_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(asset_weight, same_asset_weight_diff_imf_factor);

        let lib_weight = spot_market
            .get_liability_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(lib_weight, 14052);

        spot_market.imf_factor = SPOT_IMF_PRECISION / 10;
        let asset_weight = spot_market
            .get_asset_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(asset_weight, 2642);

        let lib_weight = spot_market
            .get_liability_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(lib_weight, 41522);

        let maint_lib_weight = spot_market
            .get_liability_weight(size, &MarginRequirementType::Maintenance)
            .unwrap();
        assert_eq!(maint_lib_weight, 31622);
    }

    #[test]
    fn negative_margin_user_test() {
        let spot_market = SpotMarket {
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            ..SpotMarket::default()
        };

        let spot_position = SpotPosition {
            balance_type: SpotBalanceType::Deposit,
            balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };

        let mut user = User { ..User::default() };

        let market_position = PerpPosition {
            market_index: 0,
            quote_asset_amount: -2 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        };

        user.spot_positions[0] = spot_position;
        user.perp_positions[0] = market_position;

        let market = PerpMarket {
            market_index: 0,
            amm: AMM {
                base_asset_reserve: 5122950819670000,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 22_100_000,
                net_base_asset_amount: -(122950819670000_i128),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            imf_factor: 1000, // 1_000/1_000_000 = .001
            unrealized_initial_asset_weight: 10000,
            unrealized_maintenance_asset_weight: 10000,
            ..PerpMarket::default()
        };

        // btc
        let oracle_price_data = OraclePriceData {
            price: (22050 * PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let (_, unrealized_pnl, _) = calculate_perp_position_value_and_pnl(
            &market_position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
            0,
        )
        .unwrap();

        let quote_asset_oracle_price_data = OraclePriceData {
            price: PRICE_PRECISION as i128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let total_collateral = calculate_spot_position_value(
            &spot_position,
            &spot_market,
            &quote_asset_oracle_price_data,
            MarginRequirementType::Initial,
        )
        .unwrap();

        let total_collateral_updated =
            calculate_updated_collateral(total_collateral, unrealized_pnl).unwrap();

        assert_eq!(total_collateral_updated, 0);

        let total_collateral_i128 = (total_collateral as i128) + unrealized_pnl;

        assert_eq!(total_collateral_i128, -(2 * QUOTE_PRECISION as i128));
    }

    #[test]
    fn calculate_user_equity_value_tests() {
        let _user = User { ..User::default() };

        let spot_position = SpotPosition {
            balance_type: SpotBalanceType::Deposit,
            balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };

        let spot_market = SpotMarket {
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            ..SpotMarket::default()
        };

        let mut market = PerpMarket {
            market_index: 0,
            amm: AMM {
                base_asset_reserve: 512295081967,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 22_100_000_000,
                net_base_asset_amount: -(12295081967_i128),
                max_spread: 1000,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            imf_factor: 1000, // 1_000/1_000_000 = .001
            unrealized_initial_asset_weight: 10000,
            unrealized_maintenance_asset_weight: 10000,
            ..PerpMarket::default()
        };

        let current_price = market.amm.reserve_price().unwrap();
        assert_eq!(current_price, 21051929600);

        market.imf_factor = 1000; // 1_000/1_000_000 = .001

        // btc
        let mut oracle_price_data = OraclePriceData {
            price: (22050 * PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let market_position = PerpPosition {
            market_index: 0,
            base_asset_amount: -(12295081967 / 2_i64),
            quote_asset_amount: 153688524588, // $25,000 entry price
            ..PerpPosition::default()
        };

        let margin_requirement_type = MarginRequirementType::Initial;
        let quote_asset_oracle_price_data = OraclePriceData {
            price: PRICE_PRECISION as i128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };
        let _bqv = calculate_spot_position_value(
            &spot_position,
            &spot_market,
            &quote_asset_oracle_price_data,
            margin_requirement_type,
        )
        .unwrap();

        let position_unrealized_pnl =
            calculate_position_pnl(&market_position, &market.amm, false).unwrap();

        assert_eq!(position_unrealized_pnl, 22699050905);

        // sqrt of oracle price = 149
        market.unrealized_imf_factor = market.imf_factor;

        let uaw = market
            .get_unrealized_asset_weight(position_unrealized_pnl, MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(uaw, 9559);

        let (pmr, upnl, _) = calculate_perp_position_value_and_pnl(
            &market_position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
            0,
        )
        .unwrap();

        assert_eq!(upnl, 17580307388);
        assert!(upnl < position_unrealized_pnl); // margin system discounts

        assert!(pmr > 0);
        assert_eq!(pmr, 13867100408);

        oracle_price_data.price = (21050 * PRICE_PRECISION) as i128; // lower by $1000 (in favor of user)
        oracle_price_data.confidence = PRICE_PRECISION;

        let (_, position_unrealized_pnl) = calculate_base_asset_value_and_pnl_with_oracle_price(
            &market_position,
            oracle_price_data.price,
        )
        .unwrap();

        assert_eq!(position_unrealized_pnl, 24282786896); // $24.282k

        assert_eq!(
            market
                .get_unrealized_asset_weight(position_unrealized_pnl, margin_requirement_type)
                .unwrap(),
            9516
        );
        assert_eq!(
            market
                .get_unrealized_asset_weight(position_unrealized_pnl * 10, margin_requirement_type)
                .unwrap(),
            7368
        );
        assert_eq!(
            market
                .get_unrealized_asset_weight(position_unrealized_pnl * 100, margin_requirement_type)
                .unwrap(),
            4299
        );
        assert_eq!(
            market
                .get_unrealized_asset_weight(
                    position_unrealized_pnl * 1000,
                    margin_requirement_type
                )
                .unwrap(),
            1855
        );
        assert_eq!(
            market
                .get_unrealized_asset_weight(
                    position_unrealized_pnl * 10000,
                    margin_requirement_type
                )
                .unwrap(),
            663
        );
        //nice that 18000 < 60000

        assert_eq!(
            market
                .get_unrealized_asset_weight(
                    position_unrealized_pnl * 800000,
                    margin_requirement_type
                )
                .unwrap(),
            78
        );
        assert_eq!(position_unrealized_pnl * 800000, 19426229516800000); // 1.9 billion

        let (pmr_2, upnl_2, _) = calculate_perp_position_value_and_pnl(
            &market_position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
            0,
        )
        .unwrap();

        let uaw_2 = market
            .get_unrealized_asset_weight(upnl_2, MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(uaw_2, 9548);

        assert_eq!(upnl_2, 23107500010);
        assert!(upnl_2 > upnl);
        assert!(pmr_2 > 0);
        assert_eq!(pmr_2, 13238206965); //$12940.5737702000
        assert!(pmr > pmr_2);
        assert_eq!(pmr - pmr_2, 628893443);
        //-6.1475409835 * 1000 / 10 = 614.75
    }

    #[test]
    fn test_nroot() {
        let ans = (0).nth_root(2);
        assert_eq!(ans, 0);
    }

    #[test]
    fn test_lp_user_short() {
        let mut market = PerpMarket {
            market_index: 0,
            amm: AMM {
                base_asset_reserve: 5 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 5 * AMM_RESERVE_PRECISION,
                sqrt_k: 5 * AMM_RESERVE_PRECISION,
                user_lp_shares: 10 * AMM_RESERVE_PRECISION,
                max_base_asset_reserve: 10 * AMM_RESERVE_PRECISION,
                ..AMM::default_test()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            imf_factor: 1000, // 1_000/1_000_000 = .001
            unrealized_initial_asset_weight: 10000,
            unrealized_maintenance_asset_weight: 10000,
            ..PerpMarket::default()
        };

        let position = PerpPosition {
            lp_shares: market.amm.user_lp_shares as u64,
            ..PerpPosition::default()
        };

        let oracle_price_data = OraclePriceData {
            price: (2 * PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let (pmr, _, _) = calculate_perp_position_value_and_pnl(
            &position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
            0,
        )
        .unwrap();

        // make the market unbalanced

        let trade_size = 3 * AMM_RESERVE_PRECISION;
        let (new_qar, new_bar) = calculate_swap_output(
            trade_size,
            market.amm.base_asset_reserve,
            SwapDirection::Add, // user shorts
            market.amm.sqrt_k,
        )
        .unwrap();
        market.amm.quote_asset_reserve = new_qar;
        market.amm.base_asset_reserve = new_bar;

        let (pmr2, _, _) = calculate_perp_position_value_and_pnl(
            &position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
            0,
        )
        .unwrap();

        // larger margin req in more unbalanced market
        assert!(pmr2 > pmr)
    }

    #[test]
    fn test_lp_user_long() {
        let mut market = PerpMarket {
            market_index: 0,
            amm: AMM {
                base_asset_reserve: 5 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 5 * AMM_RESERVE_PRECISION,
                sqrt_k: 5 * AMM_RESERVE_PRECISION,
                user_lp_shares: 10 * AMM_RESERVE_PRECISION,
                max_base_asset_reserve: 10 * AMM_RESERVE_PRECISION,
                ..AMM::default_test()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            imf_factor: 1000, // 1_000/1_000_000 = .001
            unrealized_initial_asset_weight: 10000,
            unrealized_maintenance_asset_weight: 10000,
            ..PerpMarket::default()
        };

        let position = PerpPosition {
            lp_shares: market.amm.user_lp_shares as u64,
            ..PerpPosition::default()
        };

        let oracle_price_data = OraclePriceData {
            price: (2 * PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let (pmr, _, _) = calculate_perp_position_value_and_pnl(
            &position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
            0,
        )
        .unwrap();

        // make the market unbalanced
        let trade_size = 3 * AMM_RESERVE_PRECISION;
        let (new_qar, new_bar) = calculate_swap_output(
            trade_size,
            market.amm.base_asset_reserve,
            SwapDirection::Remove, // user longs
            market.amm.sqrt_k,
        )
        .unwrap();
        market.amm.quote_asset_reserve = new_qar;
        market.amm.base_asset_reserve = new_bar;

        let (pmr2, _, _) = calculate_perp_position_value_and_pnl(
            &position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
            0,
        )
        .unwrap();

        // larger margin req in more unbalanced market
        assert!(pmr2 > pmr)
    }
}

#[cfg(test)]
mod calculate_margin_requirement_and_total_collateral {
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I64, LIQUIDATION_FEE_PRECISION, MARGIN_PRECISION,
        PEG_PRECISION, SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64,
        SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::math::margin::{
        calculate_margin_requirement_and_total_collateral, MarginRequirementType,
    };
    use crate::state::market::{MarketStatus, PerpMarket, AMM};
    use crate::state::oracle::OracleSource;
    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{Order, PerpPosition, SpotPosition, User};
    use crate::tests::utils::get_pyth_price;
    use crate::tests::utils::*;
    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    pub fn usdc_deposit_and_5x_sol_bid() {
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let market_map = PerpMarketMap::empty();

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            balance: 10000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            open_orders: 1,
            open_bids: 500 * 10_i64.pow(9),
            ..SpotPosition::default()
        };
        let user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let (margin_requirement, total_collateral, _, _) =
            calculate_margin_requirement_and_total_collateral(
                &user,
                &market_map,
                MarginRequirementType::Initial,
                &spot_market_map,
                &mut oracle_map,
                None,
            )
            .unwrap();

        assert_eq!(margin_requirement, 50000000000);
        assert_eq!(total_collateral, 50000000000);
    }

    #[test]
    pub fn usdc_deposit_and_5x_sol_ask() {
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let market_map = PerpMarketMap::empty();

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            balance: 10000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            open_orders: 1,
            open_asks: -500 * 10_i64.pow(9),
            ..SpotPosition::default()
        };
        let user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let (margin_requirement, total_collateral, _, _) =
            calculate_margin_requirement_and_total_collateral(
                &user,
                &market_map,
                MarginRequirementType::Initial,
                &spot_market_map,
                &mut oracle_map,
                None,
            )
            .unwrap();

        assert_eq!(margin_requirement, 60000000000);
        assert_eq!(total_collateral, 60000000000);
    }

    #[test]
    pub fn sol_deposit_and_5x_sol_ask() {
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let market_map = PerpMarketMap::empty();

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            balance: 500 * SPOT_BALANCE_PRECISION_U64,
            open_orders: 1,
            open_asks: -3000 * 10_i64.pow(9),
            ..SpotPosition::default()
        };
        let user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let (margin_requirement, total_collateral, _, _) =
            calculate_margin_requirement_and_total_collateral(
                &user,
                &market_map,
                MarginRequirementType::Initial,
                &spot_market_map,
                &mut oracle_map,
                None,
            )
            .unwrap();

        assert_eq!(margin_requirement, 300000000000);
        assert_eq!(total_collateral, 300000000000);
    }

    #[test]
    pub fn user_custom_margin_ratio() {
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
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
                base_asset_amount_step_size: 10000000,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 10000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };

        let user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: 100 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            custom_margin_ratio: 2 * MARGIN_PRECISION as u32, // .5x leverage
            ..User::default()
        };

        let (margin_requirement, _, _, _) = calculate_margin_requirement_and_total_collateral(
            &user,
            &perp_market_map,
            MarginRequirementType::Initial,
            &spot_market_map,
            &mut oracle_map,
            None,
        )
        .unwrap();

        assert_eq!(margin_requirement, 40000000000); // 100 * $100 * 2 + 100 * $100 * 2

        let user = User {
            custom_margin_ratio: MARGIN_PRECISION as u32, // 1x leverage
            ..user
        };

        let (margin_requirement, _, _, _) = calculate_margin_requirement_and_total_collateral(
            &user,
            &perp_market_map,
            MarginRequirementType::Initial,
            &spot_market_map,
            &mut oracle_map,
            None,
        )
        .unwrap();

        assert_eq!(margin_requirement, 22000000000); // 100 * 100 * 1 + 100 * $100 * 1.2

        let user = User {
            custom_margin_ratio: MARGIN_PRECISION as u32 / 2, // 2x leverage
            ..user
        };

        let (margin_requirement, _, _, _) = calculate_margin_requirement_and_total_collateral(
            &user,
            &perp_market_map,
            MarginRequirementType::Initial,
            &spot_market_map,
            &mut oracle_map,
            None,
        )
        .unwrap();

        assert_eq!(margin_requirement, 17000000000); // 100 * 100 * .5 + 100 * $100 * 1.2

        let user = User {
            custom_margin_ratio: 10 * MARGIN_PRECISION as u32, // .1x leverage
            ..user
        };

        let (maintenance_margin_requirement, _, _, _) =
            calculate_margin_requirement_and_total_collateral(
                &user,
                &perp_market_map,
                MarginRequirementType::Maintenance,
                &spot_market_map,
                &mut oracle_map,
                None,
            )
            .unwrap();

        // doesnt affect maintenance margin requirement
        assert_eq!(maintenance_margin_requirement, 11500000000); // 100 * 100 * .05 + 100 * $100 * 1.1
    }
}
