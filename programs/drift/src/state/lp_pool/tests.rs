#[cfg(test)]
mod tests {
    use crate::math::constants::{
        BASE_PRECISION_I64, PERCENTAGE_PRECISION_I64, PRICE_PRECISION_I64, QUOTE_PRECISION,
    };
    use crate::state::lp_pool::*;
    use std::{cell::RefCell, marker::PhantomData, vec};

    fn amm_const_datum(
        perp_market_index: u16,
        constituent_index: u16,
        weight: i64,
        last_slot: u64,
    ) -> AmmConstituentDatum {
        AmmConstituentDatum {
            perp_market_index,
            constituent_index,
            weight,
            last_slot,
            ..AmmConstituentDatum::default()
        }
    }

    #[test]
    fn test_complex_implementation() {
        // Constituents are BTC, SOL, ETH, USDC

        let slot = 20202020 as u64;
        let amm_data = [
            amm_const_datum(0, 0, PERCENTAGE_PRECISION_I64, slot), // BTC-PERP
            amm_const_datum(1, 1, PERCENTAGE_PRECISION_I64, slot), // SOL-PERP
            amm_const_datum(2, 2, PERCENTAGE_PRECISION_I64, slot), // ETH-PERP
            amm_const_datum(3, 0, 46 * (PERCENTAGE_PRECISION_I64 / 100), slot), // FARTCOIN-PERP for BTC
            amm_const_datum(3, 1, 132 * (PERCENTAGE_PRECISION_I64 / 100), slot), // FARTCOIN-PERP for SOL
            amm_const_datum(3, 2, 35 * (PERCENTAGE_PRECISION_I64 / 100), slot), // FARTCOIN-PERP for ETH
        ];

        let mapping_fixed = RefCell::new(AmmConstituentMappingFixed {
            len: 6,
            ..AmmConstituentMappingFixed::default()
        });
        const LEN: usize = 6;
        const DATA_SIZE: usize = std::mem::size_of::<AmmConstituentDatum>() * LEN;
        let defaults: [AmmConstituentDatum; LEN] = [AmmConstituentDatum::default(); LEN];
        let mapping_data = RefCell::new(unsafe {
            std::mem::transmute::<[AmmConstituentDatum; LEN], [u8; DATA_SIZE]>(defaults)
        });
        {
            let mut mapping_zc_mut =
                AccountZeroCopyMut::<'_, AmmConstituentDatum, AmmConstituentMappingFixed> {
                    fixed: mapping_fixed.borrow_mut(),
                    data: mapping_data.borrow_mut(),
                    _marker: PhantomData::<AmmConstituentDatum>,
                };
            for amm_datum in amm_data {
                println!("Adding AMM Constituent Datum: {:?}", amm_datum);
                mapping_zc_mut.add_amm_constituent_datum(amm_datum).unwrap();
            }
        }

        let mapping_zc = {
            let fixed_ref = mapping_fixed.borrow();
            let data_ref = mapping_data.borrow();
            AccountZeroCopy {
                fixed: fixed_ref,
                data: data_ref,
                _marker: PhantomData::<AmmConstituentDatum>,
            }
        };

        let amm_inventory_and_price: Vec<AmmInventoryAndPrices> = vec![
            AmmInventoryAndPrices {
                inventory: 4 * BASE_PRECISION_I64,
                price: 100_000 * PRICE_PRECISION_I64,
            }, // $400k BTC
            AmmInventoryAndPrices {
                inventory: 2000 * BASE_PRECISION_I64,
                price: 200 * PRICE_PRECISION_I64,
            }, // $400k SOL
            AmmInventoryAndPrices {
                inventory: 200 * BASE_PRECISION_I64,
                price: 1500 * PRICE_PRECISION_I64,
            }, // $300k ETH
            AmmInventoryAndPrices {
                inventory: 16500 * BASE_PRECISION_I64,
                price: PRICE_PRECISION_I64,
            }, // $16.5k FARTCOIN
        ];
        let mut constituents_indexes_and_decimals_and_prices = vec![
            ConstituentIndexAndDecimalAndPrice {
                constituent_index: 0,
                decimals: 6,
                price: 100_000 * PRICE_PRECISION_I64,
            },
            ConstituentIndexAndDecimalAndPrice {
                constituent_index: 1,
                decimals: 6,
                price: 200 * PRICE_PRECISION_I64,
            },
            ConstituentIndexAndDecimalAndPrice {
                constituent_index: 2,
                decimals: 6,
                price: 1500 * PRICE_PRECISION_I64,
            },
            ConstituentIndexAndDecimalAndPrice {
                constituent_index: 3,
                decimals: 6,
                price: PRICE_PRECISION_I64,
            }, // USDC
        ];
        let aum = 2_000_000 * QUOTE_PRECISION; // $2M AUM

        let target_fixed = RefCell::new(ConstituentTargetBaseFixed {
            len: 4,
            ..ConstituentTargetBaseFixed::default()
        });
        let target_data = RefCell::new([0u8; 96]);
        let now_ts = 1234567890;
        let mut target_zc_mut = AccountZeroCopyMut::<'_, TargetsDatum, ConstituentTargetBaseFixed> {
            fixed: target_fixed.borrow_mut(),
            data: target_data.borrow_mut(),
            _marker: PhantomData::<TargetsDatum>,
        };

        target_zc_mut
            .update_target_base(
                &mapping_zc,
                &amm_inventory_and_price,
                constituents_indexes_and_decimals_and_prices.as_mut_slice(),
                now_ts,
            )
            .unwrap();

        let target_weights: Vec<i64> = target_zc_mut
            .iter()
            .enumerate()
            .map(|(index, datum)| {
                calculate_target_weight(
                    datum.target_base.cast::<i64>().unwrap(),
                    &SpotMarket::default_quote_market(),
                    amm_inventory_and_price.get(index).unwrap().price,
                    aum,
                )
                .unwrap()
            })
            .collect();

        println!("Target Weights: {:?}", target_weights);
        assert_eq!(target_weights.len(), 4);
        assert_eq!(target_weights[0], -203795); // 20.3% BTC
        assert_eq!(target_weights[1], -210890); // 21.1% SOL
        assert_eq!(target_weights[2], -152887); // 15.3% ETH
        assert_eq!(target_weights[3], 0); // USDC not set if it's not in AUM update
    }

    #[test]
    fn test_single_zero_weight() {
        let amm_datum = amm_const_datum(0, 1, 0, 0);
        let mapping_fixed = RefCell::new(AmmConstituentMappingFixed {
            len: 1,
            ..AmmConstituentMappingFixed::default()
        });
        let mapping_data = RefCell::new([0u8; 24]);
        {
            let mut mapping_zc_mut =
                AccountZeroCopyMut::<'_, AmmConstituentDatum, AmmConstituentMappingFixed> {
                    fixed: mapping_fixed.borrow_mut(),
                    data: mapping_data.borrow_mut(),
                    _marker: PhantomData::<AmmConstituentDatum>,
                };
            mapping_zc_mut.add_amm_constituent_datum(amm_datum).unwrap();
        }

        let mapping_zc = {
            let fixed_ref = mapping_fixed.borrow();
            let data_ref = mapping_data.borrow();
            AccountZeroCopy {
                fixed: fixed_ref,
                data: data_ref,
                _marker: PhantomData::<AmmConstituentDatum>,
            }
        };

        let amm_inventory_and_prices: Vec<AmmInventoryAndPrices> = vec![AmmInventoryAndPrices {
            inventory: 1_000_000,
            price: 1_000_000,
        }];
        let mut constituents_indexes_and_decimals_and_prices =
            vec![ConstituentIndexAndDecimalAndPrice {
                constituent_index: 1,
                decimals: 6,
                price: 1_000_000,
            }];
        let now_ts = 1000;

        let target_fixed = RefCell::new(ConstituentTargetBaseFixed {
            len: 1,
            ..ConstituentTargetBaseFixed::default()
        });
        let target_data = RefCell::new([0u8; 24]);
        let mut target_zc_mut = AccountZeroCopyMut::<'_, TargetsDatum, ConstituentTargetBaseFixed> {
            fixed: target_fixed.borrow_mut(),
            data: target_data.borrow_mut(),
            _marker: PhantomData::<TargetsDatum>,
        };

        target_zc_mut
            .update_target_base(
                &mapping_zc,
                &amm_inventory_and_prices,
                constituents_indexes_and_decimals_and_prices.as_mut_slice(),
                now_ts,
            )
            .unwrap();

        assert!(target_zc_mut.iter().all(|&x| x.target_base == 0));
        assert_eq!(target_zc_mut.len(), 1);
        assert_eq!(target_zc_mut.get(0).target_base, 0);
        assert_eq!(target_zc_mut.get(0).last_slot, now_ts);
    }

    #[test]
    fn test_single_full_weight() {
        let amm_datum = amm_const_datum(0, 1, PERCENTAGE_PRECISION_I64, 0);
        let mapping_fixed = RefCell::new(AmmConstituentMappingFixed {
            len: 1,
            ..AmmConstituentMappingFixed::default()
        });
        let mapping_data = RefCell::new([0u8; 24]);
        {
            let mut mapping_zc_mut =
                AccountZeroCopyMut::<'_, AmmConstituentDatum, AmmConstituentMappingFixed> {
                    fixed: mapping_fixed.borrow_mut(),
                    data: mapping_data.borrow_mut(),
                    _marker: PhantomData::<AmmConstituentDatum>,
                };
            mapping_zc_mut.add_amm_constituent_datum(amm_datum).unwrap();
        }

        let mapping_zc = {
            let fixed_ref = mapping_fixed.borrow();
            let data_ref = mapping_data.borrow();
            AccountZeroCopy {
                fixed: fixed_ref,
                data: data_ref,
                _marker: PhantomData::<AmmConstituentDatum>,
            }
        };

        let price = PRICE_PRECISION_I64;
        let amm_inventory_and_prices: Vec<AmmInventoryAndPrices> = vec![AmmInventoryAndPrices {
            inventory: BASE_PRECISION_I64,
            price,
        }];
        let mut constituents_indexes_and_decimals_and_prices =
            vec![ConstituentIndexAndDecimalAndPrice {
                constituent_index: 1,
                decimals: 6,
                price,
            }];
        let aum = 1_000_000;
        let now_ts = 1234;

        let target_fixed = RefCell::new(ConstituentTargetBaseFixed {
            len: 1,
            ..ConstituentTargetBaseFixed::default()
        });
        let target_data = RefCell::new([0u8; 24]);
        let mut target_zc_mut = AccountZeroCopyMut::<'_, TargetsDatum, ConstituentTargetBaseFixed> {
            fixed: target_fixed.borrow_mut(),
            data: target_data.borrow_mut(),
            _marker: PhantomData::<TargetsDatum>,
        };

        target_zc_mut
            .update_target_base(
                &mapping_zc,
                &amm_inventory_and_prices,
                constituents_indexes_and_decimals_and_prices.as_mut_slice(),
                now_ts,
            )
            .unwrap();

        let weight = calculate_target_weight(
            target_zc_mut.get(0).target_base as i64,
            &SpotMarket::default(),
            price,
            aum,
        )
        .unwrap();

        assert_eq!(
            target_zc_mut.get(0).target_base as i128,
            -1 * 10_i128.pow(6_u32)
        );
        assert_eq!(weight, -1000000);
        assert_eq!(target_zc_mut.len(), 1);
        assert_eq!(target_zc_mut.get(0).last_slot, now_ts);
    }

    #[test]
    fn test_multiple_constituents_partial_weights() {
        let amm_mapping_data = vec![
            amm_const_datum(0, 1, PERCENTAGE_PRECISION_I64 / 2, 111),
            amm_const_datum(0, 2, PERCENTAGE_PRECISION_I64 / 2, 111),
        ];

        let mapping_fixed = RefCell::new(AmmConstituentMappingFixed {
            len: amm_mapping_data.len() as u32,
            ..AmmConstituentMappingFixed::default()
        });

        // 48 = size_of::<AmmConstituentDatum>() * amm_mapping_data.len()
        let mapping_data = RefCell::new([0u8; 48]);

        {
            let mut mapping_zc_mut =
                AccountZeroCopyMut::<'_, AmmConstituentDatum, AmmConstituentMappingFixed> {
                    fixed: mapping_fixed.borrow_mut(),
                    data: mapping_data.borrow_mut(),
                    _marker: PhantomData::<AmmConstituentDatum>,
                };
            for amm_datum in &amm_mapping_data {
                mapping_zc_mut
                    .add_amm_constituent_datum(*amm_datum)
                    .unwrap();
            }
        }

        let mapping_zc = {
            let fixed_ref = mapping_fixed.borrow();
            let data_ref = mapping_data.borrow();
            AccountZeroCopy {
                fixed: fixed_ref,
                data: data_ref,
                _marker: PhantomData::<AmmConstituentDatum>,
            }
        };

        let amm_inventory_and_prices: Vec<AmmInventoryAndPrices> = vec![AmmInventoryAndPrices {
            inventory: 1_000_000_000,
            price: 1_000_000,
        }];
        let mut constituents_indexes_and_decimals_and_prices = vec![
            ConstituentIndexAndDecimalAndPrice {
                constituent_index: 1,
                decimals: 6,
                price: 1_000_000,
            },
            ConstituentIndexAndDecimalAndPrice {
                constituent_index: 2,
                decimals: 6,
                price: 1_000_000,
            },
        ];

        let aum = 1_000_000;
        let now_ts = 999;

        let target_fixed = RefCell::new(ConstituentTargetBaseFixed {
            len: amm_mapping_data.len() as u32,
            ..ConstituentTargetBaseFixed::default()
        });
        let target_data = RefCell::new([0u8; 48]);
        let mut target_zc_mut = AccountZeroCopyMut::<'_, TargetsDatum, ConstituentTargetBaseFixed> {
            fixed: target_fixed.borrow_mut(),
            data: target_data.borrow_mut(),
            _marker: PhantomData::<TargetsDatum>,
        };

        target_zc_mut
            .update_target_base(
                &mapping_zc,
                &amm_inventory_and_prices,
                constituents_indexes_and_decimals_and_prices.as_mut_slice(),
                now_ts,
            )
            .unwrap();

        assert_eq!(target_zc_mut.len(), 2);

        for i in 0..target_zc_mut.len() {
            assert_eq!(
                calculate_target_weight(
                    target_zc_mut.get(i).target_base,
                    &SpotMarket::default_quote_market(),
                    constituents_indexes_and_decimals_and_prices
                        .get(i as usize)
                        .unwrap()
                        .price,
                    aum,
                )
                .unwrap(),
                -1 * PERCENTAGE_PRECISION_I64 / 2
            );
            assert_eq!(target_zc_mut.get(i).last_slot, now_ts);
        }
    }

    #[test]
    fn test_zero_aum_safe() {
        let amm_datum = amm_const_datum(0, 1, PERCENTAGE_PRECISION_I64, 0);
        let mapping_fixed = RefCell::new(AmmConstituentMappingFixed {
            len: 1,
            ..AmmConstituentMappingFixed::default()
        });
        let mapping_data = RefCell::new([0u8; 24]);
        {
            let mut mapping_zc_mut =
                AccountZeroCopyMut::<'_, AmmConstituentDatum, AmmConstituentMappingFixed> {
                    fixed: mapping_fixed.borrow_mut(),
                    data: mapping_data.borrow_mut(),
                    _marker: PhantomData::<AmmConstituentDatum>,
                };
            mapping_zc_mut.add_amm_constituent_datum(amm_datum).unwrap();
        }

        let mapping_zc = {
            let fixed_ref = mapping_fixed.borrow();
            let data_ref = mapping_data.borrow();
            AccountZeroCopy {
                fixed: fixed_ref,
                data: data_ref,
                _marker: PhantomData::<AmmConstituentDatum>,
            }
        };

        let amm_inventory_and_prices: Vec<AmmInventoryAndPrices> = vec![AmmInventoryAndPrices {
            inventory: 1_000_000,
            price: 142_000_000,
        }];
        let mut constituents_indexes_and_decimals_and_prices =
            vec![ConstituentIndexAndDecimalAndPrice {
                constituent_index: 1,
                decimals: 9,
                price: 142_000_000,
            }];

        let now_ts = 111;

        let target_fixed = RefCell::new(ConstituentTargetBaseFixed {
            len: 1,
            ..ConstituentTargetBaseFixed::default()
        });
        let target_data = RefCell::new([0u8; 24]);
        let mut target_zc_mut = AccountZeroCopyMut::<'_, TargetsDatum, ConstituentTargetBaseFixed> {
            fixed: target_fixed.borrow_mut(),
            data: target_data.borrow_mut(),
            _marker: PhantomData::<TargetsDatum>,
        };

        target_zc_mut
            .update_target_base(
                &mapping_zc,
                &amm_inventory_and_prices,
                constituents_indexes_and_decimals_and_prices.as_mut_slice(),
                now_ts,
            )
            .unwrap();

        assert_eq!(target_zc_mut.len(), 1);
        assert_eq!(target_zc_mut.get(0).target_base, -1_000_000); // despite no aum, desire to reach target
        assert_eq!(target_zc_mut.get(0).last_slot, now_ts);
    }
}

#[cfg(test)]
mod swap_tests {
    use crate::math::constants::{
        PERCENTAGE_PRECISION, PERCENTAGE_PRECISION_I64, PRICE_PRECISION_I128, PRICE_PRECISION_I64,
        SPOT_BALANCE_PRECISION,
    };
    use crate::state::lp_pool::*;

    #[test]
    fn test_get_swap_price() {
        let lp_pool = LPPool::default();

        let in_oracle = OraclePriceData {
            price: 1_000_000,
            ..OraclePriceData::default()
        };
        let out_oracle = OraclePriceData {
            price: 233_400_000,
            ..OraclePriceData::default()
        };

        // same decimals
        let (price_num, price_denom) = lp_pool
            .get_swap_price(6, 6, &in_oracle, &out_oracle)
            .unwrap();
        assert_eq!(price_num, 1_000_000);
        assert_eq!(price_denom, 233_400_000);

        let (price_num, price_denom) = lp_pool
            .get_swap_price(6, 6, &out_oracle, &in_oracle)
            .unwrap();
        assert_eq!(price_num, 233_400_000);
        assert_eq!(price_denom, 1_000_000);
    }

    fn get_swap_amount_decimals_scenario(
        in_current_weight: u64,
        out_current_weight: u64,
        in_decimals: u32,
        out_decimals: u32,
        in_amount: u64,
        expected_in_amount: u128,
        expected_out_amount: u128,
        expected_in_fee: i128,
        expected_out_fee: i128,
        in_xi: u8,
        out_xi: u8,
        in_gamma_inventory: u8,
        out_gamma_inventory: u8,
        in_gamma_execution: u8,
        out_gamma_execution: u8,
        in_volatility: u64,
        out_volatility: u64,
    ) {
        let lp_pool = LPPool {
            last_aum: 1_000_000_000_000,
            ..LPPool::default()
        };

        let oracle_0 = OraclePriceData {
            price: 1_000_000,
            ..OraclePriceData::default()
        };
        let oracle_1 = OraclePriceData {
            price: 233_400_000,
            ..OraclePriceData::default()
        };

        let in_notional = (in_current_weight as u128) * lp_pool.last_aum / PERCENTAGE_PRECISION;
        let in_token_amount = in_notional * 10_u128.pow(in_decimals) / oracle_0.price as u128;

        let out_notional = (out_current_weight as u128) * lp_pool.last_aum / PERCENTAGE_PRECISION;
        let out_token_amount = out_notional * 10_u128.pow(out_decimals) / oracle_1.price as u128;

        let constituent_0 = Constituent {
            decimals: in_decimals as u8,
            swap_fee_min: PERCENTAGE_PRECISION_I64 / 10000,
            swap_fee_max: PERCENTAGE_PRECISION_I64 / 1000,
            gamma_execution: in_gamma_execution,
            gamma_inventory: in_gamma_inventory,
            xi: in_xi,
            volatility: in_volatility,
            vault_token_balance: in_token_amount as u64,
            // max_weight_deviation: PERCENTAGE_PRECISION_I64 / 10,
            ..Constituent::default()
        };
        let constituent_1 = Constituent {
            decimals: out_decimals as u8,
            swap_fee_min: PERCENTAGE_PRECISION_I64 / 10000,
            swap_fee_max: PERCENTAGE_PRECISION_I64 / 1000,
            gamma_execution: out_gamma_execution,
            gamma_inventory: out_gamma_inventory,
            xi: out_xi,
            volatility: out_volatility,
            vault_token_balance: out_token_amount as u64,
            // max_weight_deviation: PERCENTAGE_PRECISION_I64 / 10,
            ..Constituent::default()
        };
        let spot_market_0 = SpotMarket {
            decimals: in_decimals,
            ..SpotMarket::default()
        };
        let spot_market_1 = SpotMarket {
            decimals: out_decimals,
            ..SpotMarket::default()
        };

        let (in_amount, out_amount, in_fee, out_fee) = lp_pool
            .get_swap_amount(
                &oracle_0,
                &oracle_1,
                &constituent_0,
                &constituent_1,
                &spot_market_0,
                &spot_market_1,
                500_000,
                500_000,
                in_amount.cast::<u128>().unwrap(),
                0,
            )
            .unwrap();
        assert_eq!(in_amount, expected_in_amount);
        assert_eq!(out_amount, expected_out_amount);
        assert_eq!(in_fee, expected_in_fee);
        assert_eq!(out_fee, expected_out_fee);
    }

    #[test]
    fn test_get_swap_amount_in_6_out_6() {
        get_swap_amount_decimals_scenario(
            500_000,
            500_000,
            6,
            6,
            150_000_000_000,
            150_000_000_000,
            642577120,
            22500000, // 1 bps
            281448,
            1,
            2,
            1,
            2,
            1,
            2,
            0u64,
            PERCENTAGE_PRECISION_U64 * 4 / 100,
        );
    }

    #[test]
    fn test_get_swap_amount_in_6_out_9() {
        get_swap_amount_decimals_scenario(
            500_000,
            500_000,
            6,
            9,
            150_000_000_000,
            150_000_000_000,
            642577120822,
            22500000,
            282091356,
            1,
            2,
            1,
            2,
            1,
            2,
            0u64,
            PERCENTAGE_PRECISION_U64 * 4 / 100,
        );
    }

    #[test]
    fn test_get_swap_amount_in_9_out_6() {
        get_swap_amount_decimals_scenario(
            500_000,
            500_000,
            9,
            6,
            150_000_000_000_000,
            150_000_000_000_000,
            642577120,
            22500000000, // 1 bps
            281448,
            1,
            2,
            1,
            2,
            1,
            2,
            0u64,
            PERCENTAGE_PRECISION_U64 * 4 / 100,
        );
    }

    #[test]
    fn test_get_weight() {
        let c = Constituent {
            swap_fee_min: -1 * PERCENTAGE_PRECISION_I64 / 10000, // -1 bps (rebate)
            swap_fee_max: PERCENTAGE_PRECISION_I64 / 100,        // 100 bps
            max_weight_deviation: PERCENTAGE_PRECISION_I64 / 10, // 10%
            spot_market_index: 0,
            spot_balance: ConstituentSpotBalance {
                scaled_balance: 500_000,
                cumulative_deposits: 1_000_000,
                balance_type: SpotBalanceType::Deposit,
                market_index: 0,
                ..ConstituentSpotBalance::default()
            },
            vault_token_balance: 500_000,
            decimals: 6,
            ..Constituent::default()
        };

        let spot_market = SpotMarket {
            market_index: 0,
            decimals: 6,
            cumulative_deposit_interest: 10_000_000_000_000,
            ..SpotMarket::default()
        };

        let full_balance = c.get_full_token_amount(&spot_market).unwrap();
        assert_eq!(full_balance, 1_000_000);

        // 1/10 = 10%
        let weight = c
            .get_weight(
                1_000_000, // $1
                &spot_market,
                0,
                10_000_000,
            )
            .unwrap();
        assert_eq!(weight, 100_000);

        // (1+1)/10 = 20%
        let weight = c
            .get_weight(1_000_000, &spot_market, 1_000_000, 10_000_000)
            .unwrap();
        assert_eq!(weight, 200_000);

        // (1-0.5)/10 = 0.5%
        let weight = c
            .get_weight(1_000_000, &spot_market, -500_000, 10_000_000)
            .unwrap();
        assert_eq!(weight, 50_000);
    }

    fn get_add_liquidity_mint_amount_scenario(
        last_aum: u128,
        now: i64,
        in_decimals: u32,
        in_amount: u128,
        dlp_total_supply: u64,
        expected_lp_amount: u64,
        expected_lp_fee: i64,
        expected_in_fee_amount: i128,
        xi: u8,
        gamma_inventory: u8,
        gamma_execution: u8,
        volatility: u64,
    ) {
        let lp_pool = LPPool {
            last_aum,
            last_hedge_ts: 0,
            min_mint_fee: 0,
            ..LPPool::default()
        };

        let spot_market = SpotMarket {
            decimals: in_decimals,
            ..SpotMarket::default()
        };

        let token_balance = if in_decimals > 6 {
            last_aum.safe_mul(10_u128.pow(in_decimals - 6)).unwrap()
        } else {
            last_aum.safe_div(10_u128.pow(6 - in_decimals)).unwrap()
        };

        let constituent = Constituent {
            decimals: in_decimals as u8,
            swap_fee_min: 0,
            swap_fee_max: 0,
            max_weight_deviation: PERCENTAGE_PRECISION_I64 / 10,
            spot_market_index: 0,
            spot_balance: ConstituentSpotBalance {
                scaled_balance: 0,
                cumulative_deposits: 0,
                balance_type: SpotBalanceType::Deposit,
                market_index: 0,
                ..ConstituentSpotBalance::default()
            },
            vault_token_balance: token_balance as u64,
            xi,
            gamma_inventory,
            gamma_execution,
            volatility,
            ..Constituent::default()
        };

        let oracle = OraclePriceData {
            price: PRICE_PRECISION_I64, // $1
            ..OraclePriceData::default()
        };

        let (lp_amount, in_amount_1, lp_fee, in_fee_amount) = lp_pool
            .get_add_liquidity_mint_amount(
                &spot_market,
                &constituent,
                in_amount,
                &oracle,
                PERCENTAGE_PRECISION_I64, // 100% target weight, to minimize fee for this test
                dlp_total_supply,
            )
            .unwrap();

        assert_eq!(lp_amount, expected_lp_amount);
        assert_eq!(lp_fee, expected_lp_fee);
        assert_eq!(in_amount_1, in_amount);
        assert_eq!(in_fee_amount, expected_in_fee_amount);
    }

    // test with 6 decimal constituent (matches dlp precision)
    #[test]
    fn test_get_add_liquidity_mint_amount_zero_aum() {
        get_add_liquidity_mint_amount_scenario(
            0,         // last_aum
            0,         // now
            6,         // in_decimals
            1_000_000, // in_amount
            0,         // dlp_total_supply (non-zero to avoid MathError)
            1_000_000, // expected_lp_amount
            0,         // expected_lp_fee
            0,         // expected_in_fee_amount
            1, 2, 2, 0,
        );
    }

    #[test]
    fn test_get_add_liquidity_mint_amount_with_existing_aum() {
        get_add_liquidity_mint_amount_scenario(
            10_000_000_000, // last_aum ($10,000)
            0,              // now
            6,              // in_decimals
            1_000_000,      // in_amount (1 token) = $1
            10_000_000_000, // dlp_total_supply
            999700,         // expected_lp_amount
            0,              // expected_lp_fee
            300,            // expected_in_fee_amount
            1,
            2,
            2,
            0,
        );
    }

    // test with 8 decimal constituent
    #[test]
    fn test_get_add_liquidity_mint_amount_with_zero_aum_8_decimals() {
        get_add_liquidity_mint_amount_scenario(
            0,           // last_aum
            0,           // now
            8,           // in_decimals
            100_000_000, // in_amount (1 token) = $1
            0,           // dlp_total_supply
            1_000_000,   // expected_lp_amount
            0,           // expected_lp_fee
            0,           // expected_in_fee_amount
            1,
            2,
            2,
            0,
        );
    }

    #[test]
    fn test_get_add_liquidity_mint_amount_with_existing_aum_8_decimals() {
        get_add_liquidity_mint_amount_scenario(
            10_000_000_000, // last_aum ($10,000)
            0,              // now
            8,              // in_decimals
            100_000_000,    // in_amount (1 token) = $1
            10_000_000_000, // dlp_total_supply
            999700,         // expected_lp_amount in lp decimals
            0,              // expected_lp_fee
            30000,          // expected_in_fee_amount
            1,
            2,
            2,
            0,
        );
    }

    // test with 4 decimal constituent
    #[test]
    fn test_get_add_liquidity_mint_amount_with_zero_aum_4_decimals() {
        get_add_liquidity_mint_amount_scenario(
            0,       // last_aum
            0,       // now
            4,       // in_decimals
            10_000,  // in_amount (1 token) = $1
            0,       // dlp_total_supply
            1000000, // expected_lp_amount
            0,       // expected_lp_fee
            0,       // expected_in_fee_amount
            1, 2, 2, 0,
        );
    }

    #[test]
    fn test_get_add_liquidity_mint_amount_with_existing_aum_4_decimals() {
        get_add_liquidity_mint_amount_scenario(
            10_000_000_000, // last_aum ($10,000)
            0,              // now
            4,              // in_decimals
            10_000,         // in_amount (1 token) = $1
            10_000_000_000, // dlp_total_supply
            999700,         // expected_lp_amount
            0,              // expected_lp_fee
            3,              // expected_in_fee_amount
            1,
            2,
            2,
            0,
        );
    }

    fn get_remove_liquidity_mint_amount_scenario(
        last_aum: u128,
        now: i64,
        in_decimals: u32,
        lp_burn_amount: u64,
        dlp_total_supply: u64,
        expected_out_amount: u128,
        expected_lp_fee: i64,
        expected_out_fee_amount: i128,
        xi: u8,
        gamma_inventory: u8,
        gamma_execution: u8,
        volatility: u64,
    ) {
        let lp_pool = LPPool {
            last_aum,
            last_hedge_ts: 0,
            min_mint_fee: 100, // 1 bps
            ..LPPool::default()
        };

        let spot_market = SpotMarket {
            decimals: in_decimals,
            ..SpotMarket::default()
        };

        let token_balance = if in_decimals > 6 {
            last_aum.safe_mul(10_u128.pow(in_decimals - 6)).unwrap()
        } else {
            last_aum.safe_div(10_u128.pow(6 - in_decimals)).unwrap()
        };

        let constituent = Constituent {
            decimals: in_decimals as u8,
            swap_fee_min: 0,
            swap_fee_max: 0,
            max_weight_deviation: PERCENTAGE_PRECISION_I64 / 10,
            spot_market_index: 0,
            spot_balance: ConstituentSpotBalance {
                scaled_balance: 0,
                cumulative_deposits: 0,
                balance_type: SpotBalanceType::Deposit,
                market_index: 0,
                ..ConstituentSpotBalance::default()
            },
            vault_token_balance: token_balance as u64,
            xi,
            gamma_inventory,
            gamma_execution,
            volatility,
            ..Constituent::default()
        };

        let oracle = OraclePriceData {
            price: PRICE_PRECISION_I64, // $1
            ..OraclePriceData::default()
        };

        let (lp_amount_1, out_amount, lp_fee, out_fee_amount) = lp_pool
            .get_remove_liquidity_amount(
                &spot_market,
                &constituent,
                lp_burn_amount,
                &oracle,
                PERCENTAGE_PRECISION_I64, // 100% target weight, to minimize fee for this test
                dlp_total_supply,
            )
            .unwrap();

        assert_eq!(lp_amount_1, lp_burn_amount);
        assert_eq!(lp_fee, expected_lp_fee);
        assert_eq!(out_amount, expected_out_amount);
        assert_eq!(out_fee_amount, expected_out_fee_amount);
    }

    // test with 6 decimal constituent (matches dlp precision)
    #[test]
    fn test_get_remove_liquidity_mint_amount_with_existing_aum() {
        get_remove_liquidity_mint_amount_scenario(
            10_000_000_000, // last_aum ($10,000)
            0,              // now
            6,              // in_decimals
            1_000_000,      // in_amount (1 token) = $1
            10_000_000_000, // dlp_total_supply
            999900,         // expected_out_amount
            100,            // expected_lp_fee
            299,            // expected_out_fee_amount
            1,
            2,
            2,
            PERCENTAGE_PRECISION_U64 * 4 / 100, // volatility
        );
    }

    // test with 8 decimal constituent
    #[test]
    fn test_get_remove_liquidity_mint_amount_with_existing_aum_8_decimals() {
        get_remove_liquidity_mint_amount_scenario(
            10_000_000_000, // last_aum ($10,000)
            0,              // now
            8,              // in_decimals
            100_000_000,    // in_amount (1 token) = $1
            10_000_000_000, // dlp_total_supply
            9999000000,     // expected_out_amount
            10000,          // expected_lp_fee
            2999700,
            1,
            2,
            2,
            PERCENTAGE_PRECISION_U64 * 4 / 100, // volatility
        );
    }

    // test with 4 decimal constituent
    // there will be a problem with 4 decimal constituents with aum ~10M
    #[test]
    fn test_get_remove_liquidity_mint_amount_with_existing_aum_4_decimals() {
        get_remove_liquidity_mint_amount_scenario(
            10_000_000_000, // last_aum ($10,000)
            0,              // now
            4,              // in_decimals
            10_000,         // in_amount (1 token) = 1/10000
            10_000_000_000, // dlp_total_supply
            99,             // expected_out_amount
            1,              // expected_lp_fee
            0,              // expected_out_fee_amount
            1,
            2,
            2,
            PERCENTAGE_PRECISION_U64 * 4 / 100, // volatility
        );
    }

    #[test]
    fn test_get_remove_liquidity_mint_amount_with_existing_aum_5_decimals_large_aum() {
        get_remove_liquidity_mint_amount_scenario(
            100_000_000_000 * 1_000_000, // last_aum ($100,000,000,000)
            0,                           // now
            5,                           // in_decimals
            100_000_000_000 * 100_000,   // in_amount
            100_000_000_000 * 1_000_000, // dlp_total_supply
            999900000000000,             // expected_out_amount
            1000000000000,               // expected_lp_fee
            473952600000,                // expected_out_fee_amount
            1,
            2,
            2,
            PERCENTAGE_PRECISION_U64 * 4 / 100, // volatility
        );
    }

    #[test]
    fn test_get_remove_liquidity_mint_amount_with_existing_aum_6_decimals_large_aum() {
        get_remove_liquidity_mint_amount_scenario(
            100_000_000_000 * 1_000_000, // last_aum ($100,000,000,000)
            0,                           // now
            6,                           // in_decimals
            100_000_000_000 * 1_000_000, // in_amount
            100_000_000_000 * 1_000_000, // dlp_total_supply
            99990000000000000,           // expected_out_amount
            10000000000000,              // expected_lp_fee
            349765020000000,             // expected_out_fee_amount
            1,
            2,
            2,
            PERCENTAGE_PRECISION_U64 * 4 / 100, // volatility
        );
    }

    #[test]
    fn test_get_remove_liquidity_mint_amount_with_existing_aum_8_decimals_large_aum() {
        get_remove_liquidity_mint_amount_scenario(
            10_000_000_000_000_000,       // last_aum ($10,000,000,000)
            0,                            // now
            8,                            // in_decimals
            10_000_000_000 * 100_000_000, // in_amount
            10_000_000_000 * 1_000_000,   // dlp_total_supply
            9_999_000_000_000_000_0000,   // expected_out_amount
            100000000000000,              // expected_lp_fee
            3764623500000000000,          // expected_out_fee_amount
            1,
            2,
            2,
            PERCENTAGE_PRECISION_U64 * 4 / 100, // volatility
        );
    }

    fn round_to_sig(x: i128, sig: u32) -> i128 {
        if x == 0 {
            return 0;
        }
        let digits = (x.abs() as f64).log10().floor() as u32 + 1;
        let factor = 10_i128.pow(digits - sig);
        ((x + factor / 2) / factor) * factor
    }

    fn get_swap_amounts(
        in_oracle_price: i64,
        out_oracle_price: i64,
        in_current_weight: i64,
        out_current_weight: i64,
        in_amount: u64,
        in_volatility: u64,
        out_volatility: u64,
        in_target_weight: i64,
        out_target_weight: i64,
    ) -> (u128, u128, i128, i128, i128, i128) {
        let lp_pool = LPPool {
            last_aum: 1_000_000_000_000,
            ..LPPool::default()
        };

        let oracle_0 = OraclePriceData {
            price: in_oracle_price,
            ..OraclePriceData::default()
        };
        let oracle_1 = OraclePriceData {
            price: out_oracle_price,
            ..OraclePriceData::default()
        };

        let in_notional = (in_current_weight as i128) * lp_pool.last_aum.cast::<i128>().unwrap()
            / PERCENTAGE_PRECISION_I128;
        let in_token_amount = in_notional * 10_i128.pow(6) / oracle_0.price as i128;
        let in_spot_balance = if in_token_amount > 0 {
            ConstituentSpotBalance {
                scaled_balance: (in_token_amount.abs() as u128)
                    * (SPOT_BALANCE_PRECISION / 10_u128.pow(6)),
                balance_type: SpotBalanceType::Deposit,
                market_index: 0,
                ..ConstituentSpotBalance::default()
            }
        } else {
            ConstituentSpotBalance {
                scaled_balance: (in_token_amount.abs() as u128)
                    * (SPOT_BALANCE_PRECISION / 10_u128.pow(6)),
                balance_type: SpotBalanceType::Borrow,
                market_index: 0,
                ..ConstituentSpotBalance::default()
            }
        };

        let out_notional = (out_current_weight as i128) * lp_pool.last_aum.cast::<i128>().unwrap()
            / PERCENTAGE_PRECISION_I128;
        let out_token_amount = out_notional * 10_i128.pow(6) / oracle_1.price as i128;
        let out_spot_balance = if out_token_amount > 0 {
            ConstituentSpotBalance {
                scaled_balance: (out_token_amount.abs() as u128)
                    * (SPOT_BALANCE_PRECISION / 10_u128.pow(6)),
                balance_type: SpotBalanceType::Deposit,
                market_index: 0,
                ..ConstituentSpotBalance::default()
            }
        } else {
            ConstituentSpotBalance {
                scaled_balance: (out_token_amount.abs() as u128)
                    * (SPOT_BALANCE_PRECISION / 10_u128.pow(6)),
                balance_type: SpotBalanceType::Deposit,
                market_index: 0,
                ..ConstituentSpotBalance::default()
            }
        };

        let constituent_0 = Constituent {
            decimals: 6,
            swap_fee_min: PERCENTAGE_PRECISION_I64 / 10000,
            swap_fee_max: PERCENTAGE_PRECISION_I64 / 1000,
            gamma_execution: 1,
            gamma_inventory: 1,
            xi: 1,
            volatility: in_volatility,
            spot_balance: in_spot_balance,
            ..Constituent::default()
        };
        let constituent_1 = Constituent {
            decimals: 6,
            swap_fee_min: PERCENTAGE_PRECISION_I64 / 10000,
            swap_fee_max: PERCENTAGE_PRECISION_I64 / 1000,
            gamma_execution: 2,
            gamma_inventory: 2,
            xi: 2,
            volatility: out_volatility,
            spot_balance: out_spot_balance,
            ..Constituent::default()
        };
        let spot_market_0 = SpotMarket {
            decimals: 6,
            ..SpotMarket::default()
        };
        let spot_market_1 = SpotMarket {
            decimals: 6,
            ..SpotMarket::default()
        };

        let (in_amount_result, out_amount, in_fee, out_fee) = lp_pool
            .get_swap_amount(
                &oracle_0,
                &oracle_1,
                &constituent_0,
                &constituent_1,
                &spot_market_0,
                &spot_market_1,
                in_target_weight,
                out_target_weight,
                in_amount.cast::<u128>().unwrap(),
                0,
            )
            .unwrap();

        return (
            in_amount_result,
            out_amount,
            in_fee,
            out_fee,
            in_token_amount,
            out_token_amount,
        );
    }

    #[test]
    fn grid_search_swap() {
        let weights: [i64; 20] = [
            -100_000, -200_000, -300_000, -400_000, -500_000, -600_000, -700_000, -800_000,
            -900_000, -1_000_000, 100_000, 200_000, 300_000, 400_000, 500_000, 600_000, 700_000,
            800_000, 900_000, 1_000_000,
        ];
        let in_amounts: Vec<u64> = (0..=10)
            .map(|i| (1000 + i * 20000) * 10_u64.pow(6))
            .collect();

        let volatilities: Vec<u64> = (1..=10)
            .map(|i| PERCENTAGE_PRECISION_U64 * i / 100)
            .collect();

        let in_oracle_price = PRICE_PRECISION_I64; // $1
        let out_oracle_price = 233_400_000; // $233.4

        // Assert monotonically increasing fees in in_amounts
        for in_current_weight in weights.iter() {
            let out_current_weight = 1_000_000 - *in_current_weight;
            for out_volatility in volatilities.iter() {
                let mut prev_in_fee_bps = 0_i128;
                let mut prev_out_fee_bps = 0_i128;
                for in_amount in in_amounts.iter() {
                    let (
                        in_amount_result,
                        out_amount,
                        in_fee,
                        out_fee,
                        in_token_amount_pre,
                        out_token_amount_pre,
                    ) = get_swap_amounts(
                        in_oracle_price,
                        out_oracle_price,
                        *in_current_weight,
                        out_current_weight,
                        *in_amount,
                        0,
                        *out_volatility,
                        PERCENTAGE_PRECISION_I64, // 100% target weight
                        PERCENTAGE_PRECISION_I64, // 100% target weight
                    );

                    // Calculate fee in basis points with precision
                    let in_fee_bps = if in_amount_result > 0 {
                        (in_fee * 10_000 * 1_000_000) / in_amount_result as i128
                    } else {
                        0
                    };

                    let out_fee_bps = if out_amount > 0 {
                        (out_fee * 10_000 * 1_000_000) / out_amount as i128
                    } else {
                        0
                    };

                    // Assert monotonically increasing fees
                    if in_amounts.iter().position(|&x| x == *in_amount).unwrap() > 0 {
                        assert!(
                                in_fee_bps >= prev_in_fee_bps,
                                "in_fee should be monotonically increasing. Current: {} bps, Previous: {} bps, weight: {}, amount: {}, volatility: {}",
                                in_fee_bps as f64 / 1_000_000.0,
                                prev_in_fee_bps as f64 / 1_000_000.0,
                                in_current_weight,
                                in_amount,
                                out_volatility
                            );
                        assert!(
                                out_fee_bps >= prev_out_fee_bps,
                                "out_fee should be monotonically increasing. Current: {} bps, Previous: {} bps, weight: {}, amount: {}, volatility: {}",
                                out_fee_bps as f64 / 1_000_000.0,
                                prev_out_fee_bps as f64 / 1_000_000.0,
                                out_current_weight,
                                in_amount,
                                out_volatility
                            );
                    }

                    println!(
                            "in_weight: {}, out_weight: {}, in_amount: {}, out_amount: {}, in_fee: {:.6} bps, out_fee: {:.6} bps",
                            in_current_weight,
                            out_current_weight,
                            in_amount_result,
                            out_amount,
                            in_fee_bps as f64 / 1_000_000.0,
                            out_fee_bps as f64 / 1_000_000.0
                        );

                    prev_in_fee_bps = in_fee_bps;
                    prev_out_fee_bps = out_fee_bps;
                }
            }
        }

        // Assert monotonically increasing fees based on error improvement
        for in_amount in in_amounts.iter() {
            for in_current_weight in weights.iter() {
                let out_current_weight = 1_000_000 - *in_current_weight;
                let fixed_volatility = PERCENTAGE_PRECISION_U64 * 5 / 100;
                let target_weights: Vec<i64> = (1..=20).map(|i| i * 50_000).collect();

                let mut results: Vec<(i128, i128, i128, i128, i128, i128)> = Vec::new();

                for target_weight in target_weights.iter() {
                    let in_target_weight = *target_weight;
                    let out_target_weight = 1_000_000 - in_target_weight;

                    let (
                        in_amount_result,
                        out_amount,
                        in_fee,
                        out_fee,
                        in_token_amount_pre,
                        out_token_amount_pre,
                    ) = get_swap_amounts(
                        in_oracle_price,
                        out_oracle_price,
                        *in_current_weight,
                        out_current_weight,
                        *in_amount,
                        fixed_volatility,
                        fixed_volatility,
                        in_target_weight,
                        out_target_weight,
                    );

                    // Calculate weights after swap

                    let out_token_after = out_token_amount_pre - out_amount as i128 + out_fee;
                    let in_token_after = in_token_amount_pre + in_amount_result as i128;

                    let out_notional_after =
                        out_token_after * (out_oracle_price as i128) / PRICE_PRECISION_I128;
                    let in_notional_after =
                        in_token_after * (in_oracle_price as i128) / PRICE_PRECISION_I128;
                    let total_notional_after = in_notional_after + out_notional_after;

                    let out_weight_after =
                        (out_notional_after * PERCENTAGE_PRECISION_I128) / (total_notional_after);
                    let in_weight_after =
                        (in_notional_after * PERCENTAGE_PRECISION_I128) / (total_notional_after);

                    // Calculate error improvement (positive means improvement)
                    let in_error_before = (*in_current_weight - in_target_weight).abs() as i128;
                    let out_error_before = (out_current_weight - out_target_weight).abs() as i128;

                    let in_error_after = (in_weight_after - in_target_weight as i128).abs();
                    let out_error_after = (out_weight_after - out_target_weight as i128).abs();

                    let in_error_improvement = round_to_sig(in_error_before - in_error_after, 2);
                    let out_error_improvement = round_to_sig(out_error_before - out_error_after, 2);

                    let in_fee_bps = if in_amount_result > 0 {
                        (in_fee * 10_000 * 1_000_000) / in_amount_result as i128
                    } else {
                        0
                    };

                    let out_fee_bps = if out_amount > 0 {
                        (out_fee * 10_000 * 1_000_000) / out_amount as i128
                    } else {
                        0
                    };

                    results.push((
                        in_error_improvement,
                        out_error_improvement,
                        in_fee_bps,
                        out_fee_bps,
                        in_target_weight as i128,
                        out_target_weight as i128,
                    ));

                    println!(
                    "in_weight: {}, out_weight: {}, in_target: {}, out_target: {}, in_error_improvement: {}, out_error_improvement: {}, in_fee: {:.6} bps, out_fee: {:.6} bps",
                    in_current_weight,
                    out_current_weight,
                    in_target_weight,
                    out_target_weight,
                    in_error_improvement,
                    out_error_improvement,
                    in_fee_bps as f64 / 1_000_000.0,
                    out_fee_bps as f64 / 1_000_000.0
                );
                }

                // Sort by in_error_improvement and check monotonicity
                results.sort_by_key(|&(in_error_improvement, _, _, _, _, _)| -in_error_improvement);

                for i in 1..results.len() {
                    let (prev_in_improvement, _, prev_in_fee_bps, _, _, _) = results[i - 1];
                    let (curr_in_improvement, _, curr_in_fee_bps, _, in_target, _) = results[i];

                    // Less improvement should mean higher fees
                    if curr_in_improvement < prev_in_improvement {
                        assert!(
                        curr_in_fee_bps >= prev_in_fee_bps,
                        "in_fee should increase as error improvement decreases. Current improvement: {}, Previous improvement: {}, Current fee: {:.6} bps, Previous fee: {:.6} bps, in_weight: {}, in_target: {}",
                        curr_in_improvement,
                        prev_in_improvement,
                        curr_in_fee_bps as f64 / 1_000_000.0,
                        prev_in_fee_bps as f64 / 1_000_000.0,
                        in_current_weight,
                        in_target
                    );
                    }
                }

                // Sort by out_error_improvement and check monotonicity
                results
                    .sort_by_key(|&(_, out_error_improvement, _, _, _, _)| -out_error_improvement);

                for i in 1..results.len() {
                    let (_, prev_out_improvement, _, prev_out_fee_bps, _, _) = results[i - 1];
                    let (_, curr_out_improvement, _, curr_out_fee_bps, _, out_target) = results[i];

                    // Less improvement should mean higher fees
                    if curr_out_improvement < prev_out_improvement {
                        assert!(
                        curr_out_fee_bps >= prev_out_fee_bps,
                        "out_fee should increase as error improvement decreases. Current improvement: {}, Previous improvement: {}, Current fee: {:.6} bps, Previous fee: {:.6} bps, out_weight: {}, out_target: {}",
                        curr_out_improvement,
                        prev_out_improvement,
                        curr_out_fee_bps as f64 / 1_000_000.0,
                        prev_out_fee_bps as f64 / 1_000_000.0,
                        out_current_weight,
                        out_target
                    );
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod swap_fee_tests {
    use crate::math::constants::{
        PERCENTAGE_PRECISION_I64, PERCENTAGE_PRECISION_U64, QUOTE_PRECISION,
    };
    use crate::state::lp_pool::*;

    #[test]
    fn test_get_gamma_covar_matrix() {
        // in = sol, out = btc
        let covar_matrix = get_gamma_covar_matrix(
            PERCENTAGE_PRECISION_I64,
            2,                                  // gamma sol
            2,                                  // gamma btc
            4 * PERCENTAGE_PRECISION_U64 / 100, // vol sol
            3 * PERCENTAGE_PRECISION_U64 / 100, // vol btc
        )
        .unwrap();
        assert_eq!(covar_matrix, [[3200, 2400], [2400, 1800]]);
    }

    #[test]
    fn test_lp_pool_get_linear_fee_execution() {
        let lp_pool = LPPool {
            last_aum: 10_000_000 * QUOTE_PRECISION, // $10,000,000
            ..LPPool::default()
        };

        let trade_ratio = 5_000_000 * QUOTE_PRECISION_I128 * PERCENTAGE_PRECISION_I128
            / (15_000_000 * QUOTE_PRECISION_I128);

        let fee_execution_linear = lp_pool
            .get_linear_fee_execution(
                trade_ratio,
                1600, // 0.0016
                2,
            )
            .unwrap();

        assert_eq!(fee_execution_linear, 1066); // 10.667 bps
    }

    #[test]
    fn test_lp_pool_get_quadratic_fee_execution() {
        let lp_pool = LPPool {
            last_aum: 10_000_000 * QUOTE_PRECISION, // $10,000,000
            ..LPPool::default()
        };

        let trade_ratio = 5_000_000 * QUOTE_PRECISION_I128 * PERCENTAGE_PRECISION_I128
            / (15_000_000 * QUOTE_PRECISION_I128);

        let fee_execution_quadratic = lp_pool
            .get_quadratic_fee_execution(
                trade_ratio,
                1600, // 0.0016
                2,
            )
            .unwrap();

        assert_eq!(fee_execution_quadratic, 711); // 7.1 bps
    }

    #[test]
    fn test_lp_pool_get_quadratic_fee_inventory() {
        let lp_pool = LPPool {
            last_aum: 10_000_000 * QUOTE_PRECISION, // $10,000,000
            ..LPPool::default()
        };

        let (fee_in, fee_out) = lp_pool
            .get_quadratic_fee_inventory(
                [[3200, 2400], [2400, 1800]],
                [
                    1_000_000 * QUOTE_PRECISION_I128,
                    -500_000 * QUOTE_PRECISION_I128,
                ],
                [
                    -4_000_000 * QUOTE_PRECISION_I128,
                    4_500_000 * QUOTE_PRECISION_I128,
                ],
                5_000_000 * QUOTE_PRECISION,
            )
            .unwrap();

        assert_eq!(fee_in, 6 * PERCENTAGE_PRECISION_I128 / 100000); // 0.6 bps
        assert_eq!(fee_out, -6 * PERCENTAGE_PRECISION_I128 / 100000); // -0.6 bps
    }
}

#[cfg(test)]
mod settle_tests {
    use crate::math::lp_pool::perp_lp_pool_settlement::{
        calculate_settlement_amount, update_cache_info, SettlementContext, SettlementDirection,
        SettlementResult,
    };
    use crate::state::amm_cache::CacheInfo;
    use crate::state::spot_market::SpotMarket;

    fn create_mock_spot_market() -> SpotMarket {
        SpotMarket::default()
    }

    #[test]
    fn test_calculate_settlement_no_amount_owed() {
        let ctx = SettlementContext {
            quote_owed_from_lp: 0,
            quote_constituent_token_balance: 1000,
            fee_pool_balance: 500,
            pnl_pool_balance: 300,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::None);
        assert_eq!(result.amount_transferred, 0);
    }

    #[test]
    fn test_lp_to_perp_settlement_sufficient_balance() {
        let ctx = SettlementContext {
            quote_owed_from_lp: 500,
            quote_constituent_token_balance: 1000,
            fee_pool_balance: 300,
            pnl_pool_balance: 200,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::FromLpPool);
        assert_eq!(result.amount_transferred, 500);
        assert_eq!(result.fee_pool_used, 0);
        assert_eq!(result.pnl_pool_used, 0);
    }

    #[test]
    fn test_lp_to_perp_settlement_insufficient_balance() {
        let ctx = SettlementContext {
            quote_owed_from_lp: 1500,
            quote_constituent_token_balance: 1000,
            fee_pool_balance: 300,
            pnl_pool_balance: 200,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::FromLpPool);
        assert_eq!(result.amount_transferred, 1000); // Limited by LP balance
    }

    #[test]
    fn test_lp_to_perp_settlement_no_lp_balance() {
        let ctx = SettlementContext {
            quote_owed_from_lp: 500,
            quote_constituent_token_balance: 0,
            fee_pool_balance: 300,
            pnl_pool_balance: 200,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::None);
        assert_eq!(result.amount_transferred, 0);
    }

    #[test]
    fn test_perp_to_lp_settlement_fee_pool_sufficient() {
        let ctx = SettlementContext {
            quote_owed_from_lp: -500,
            quote_constituent_token_balance: 1000,
            fee_pool_balance: 800,
            pnl_pool_balance: 200,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::ToLpPool);
        assert_eq!(result.amount_transferred, 500);
        assert_eq!(result.fee_pool_used, 500);
        assert_eq!(result.pnl_pool_used, 0);
    }

    #[test]
    fn test_perp_to_lp_settlement_needs_both_pools() {
        let ctx = SettlementContext {
            quote_owed_from_lp: -1000,
            quote_constituent_token_balance: 2000,
            fee_pool_balance: 300,
            pnl_pool_balance: 800,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::ToLpPool);
        assert_eq!(result.amount_transferred, 1000);
        assert_eq!(result.fee_pool_used, 300);
        assert_eq!(result.pnl_pool_used, 700);
    }

    #[test]
    fn test_perp_to_lp_settlement_insufficient_pools() {
        let ctx = SettlementContext {
            quote_owed_from_lp: -1500,
            quote_constituent_token_balance: 2000,
            fee_pool_balance: 300,
            pnl_pool_balance: 200,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::ToLpPool);
        assert_eq!(result.amount_transferred, 500); // Limited by pool balances
        assert_eq!(result.fee_pool_used, 300);
        assert_eq!(result.pnl_pool_used, 200);
    }

    #[test]
    fn test_settlement_edge_cases() {
        // Test with zero fee pool
        let ctx = SettlementContext {
            quote_owed_from_lp: -500,
            quote_constituent_token_balance: 1000,
            fee_pool_balance: 0,
            pnl_pool_balance: 800,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.amount_transferred, 500);
        assert_eq!(result.fee_pool_used, 0);
        assert_eq!(result.pnl_pool_used, 500);

        // Test with zero pnl pool
        let ctx = SettlementContext {
            quote_owed_from_lp: -500,
            quote_constituent_token_balance: 1000,
            fee_pool_balance: 300,
            pnl_pool_balance: 0,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.amount_transferred, 300);
        assert_eq!(result.fee_pool_used, 300);
        assert_eq!(result.pnl_pool_used, 0);
    }

    #[test]
    fn test_update_cache_info_to_lp_pool() {
        let mut cache = CacheInfo {
            quote_owed_from_lp_pool: -400,
            last_fee_pool_token_amount: 2_000,
            last_net_pnl_pool_token_amount: 500,
            last_settle_amount: 0,
            last_settle_slot: 0,
            ..Default::default()
        };

        let result = SettlementResult {
            amount_transferred: 200,
            direction: SettlementDirection::ToLpPool,
            fee_pool_used: 120,
            pnl_pool_used: 80,
        };
        let new_quote_owed = cache.quote_owed_from_lp_pool + result.amount_transferred as i64;
        let ts = 99;
        let slot = 100;

        update_cache_info(&mut cache, &result, new_quote_owed, slot, ts).unwrap();

        // quote_owed updated
        assert_eq!(cache.quote_owed_from_lp_pool, new_quote_owed);
        // settle fields updated
        assert_eq!(cache.last_settle_amount, 200);
        assert_eq!(cache.last_settle_slot, slot);
        // fee pool decreases by fee_pool_used
        assert_eq!(cache.last_fee_pool_token_amount, 2_000 - 120);
        // pnl pool decreases by pnl_pool_used
        assert_eq!(cache.last_net_pnl_pool_token_amount, 500 - 80);
    }

    #[test]
    fn test_update_cache_info_from_lp_pool() {
        let mut cache = CacheInfo {
            quote_owed_from_lp_pool: 500,
            last_fee_pool_token_amount: 1_000,
            last_net_pnl_pool_token_amount: 200,
            last_settle_amount: 0,
            last_settle_slot: 0,
            ..Default::default()
        };

        let result = SettlementResult {
            amount_transferred: 150,
            direction: SettlementDirection::FromLpPool,
            fee_pool_used: 0,
            pnl_pool_used: 0,
        };
        let new_quote_owed = cache.quote_owed_from_lp_pool - result.amount_transferred as i64;
        let ts = 42;
        let slot = 100;

        update_cache_info(&mut cache, &result, new_quote_owed, slot, ts).unwrap();

        // quote_owed updated
        assert_eq!(cache.quote_owed_from_lp_pool, new_quote_owed);
        // settle fields updated
        assert_eq!(cache.last_settle_amount, 150);
        assert_eq!(cache.last_settle_slot, slot);
        // fee pool increases by amount_transferred
        assert_eq!(cache.last_fee_pool_token_amount, 1_000 + 150);
        // pnl pool untouched
        assert_eq!(cache.last_net_pnl_pool_token_amount, 200);
    }

    #[test]
    fn test_large_settlement_amounts() {
        // Test with very large amounts to check for overflow
        let ctx = SettlementContext {
            quote_owed_from_lp: i64::MAX / 2,
            quote_constituent_token_balance: u64::MAX / 2,
            fee_pool_balance: u128::MAX / 4,
            pnl_pool_balance: u128::MAX / 4,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::FromLpPool);
        assert!(result.amount_transferred > 0);
    }

    #[test]
    fn test_negative_large_settlement_amounts() {
        let ctx = SettlementContext {
            quote_owed_from_lp: i64::MIN / 2,
            quote_constituent_token_balance: u64::MAX / 2,
            fee_pool_balance: u128::MAX / 4,
            pnl_pool_balance: u128::MAX / 4,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::ToLpPool);
        assert!(result.amount_transferred > 0);
    }

    #[test]
    fn test_exact_boundary_settlements() {
        // Test when quote_owed exactly equals LP balance
        let ctx = SettlementContext {
            quote_owed_from_lp: 1000,
            quote_constituent_token_balance: 1000,
            fee_pool_balance: 500,
            pnl_pool_balance: 300,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::FromLpPool);
        assert_eq!(result.amount_transferred, 1000);

        // Test when negative quote_owed exactly equals total pool balance
        let ctx = SettlementContext {
            quote_owed_from_lp: -800,
            quote_constituent_token_balance: 2000,
            fee_pool_balance: 500,
            pnl_pool_balance: 300,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::ToLpPool);
        assert_eq!(result.amount_transferred, 800);
        assert_eq!(result.fee_pool_used, 500);
        assert_eq!(result.pnl_pool_used, 300);
    }

    #[test]
    fn test_minimal_settlement_amounts() {
        // Test with minimal positive amount
        let ctx = SettlementContext {
            quote_owed_from_lp: 1,
            quote_constituent_token_balance: 1,
            fee_pool_balance: 1,
            pnl_pool_balance: 1,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::FromLpPool);
        assert_eq!(result.amount_transferred, 1);

        // Test with minimal negative amount
        let ctx = SettlementContext {
            quote_owed_from_lp: -1,
            quote_constituent_token_balance: 1,
            fee_pool_balance: 1,
            pnl_pool_balance: 0,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::ToLpPool);
        assert_eq!(result.amount_transferred, 1);
        assert_eq!(result.fee_pool_used, 1);
        assert_eq!(result.pnl_pool_used, 0);
    }

    #[test]
    fn test_all_zero_balances() {
        let ctx = SettlementContext {
            quote_owed_from_lp: -500,
            quote_constituent_token_balance: 0,
            fee_pool_balance: 0,
            pnl_pool_balance: 0,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::ToLpPool);
        assert_eq!(result.amount_transferred, 0);
        assert_eq!(result.fee_pool_used, 0);
        assert_eq!(result.pnl_pool_used, 0);
    }

    #[test]
    fn test_cache_info_update_none_direction() {
        let mut cache = CacheInfo {
            quote_owed_from_lp_pool: 100,
            last_fee_pool_token_amount: 1000,
            last_net_pnl_pool_token_amount: 500,
            last_settle_amount: 50,
            last_settle_slot: 12345,
            ..Default::default()
        };

        let result = SettlementResult {
            amount_transferred: 0,
            direction: SettlementDirection::None,
            fee_pool_used: 0,
            pnl_pool_used: 0,
        };
        let new_quote_owed = 100; // No change
        let ts = 67890;
        let slot = 100000000;

        update_cache_info(&mut cache, &result, new_quote_owed, slot, ts).unwrap();

        // quote_owed unchanged
        assert_eq!(cache.quote_owed_from_lp_pool, 100);
        // settle fields updated with new timestamp but zero amount
        assert_eq!(cache.last_settle_amount, 0);
        assert_eq!(cache.last_settle_slot, slot);
        // pool amounts unchanged
        assert_eq!(cache.last_fee_pool_token_amount, 1000);
        assert_eq!(cache.last_net_pnl_pool_token_amount, 500);
    }

    #[test]
    fn test_cache_info_update_maximum_values() {
        let mut cache = CacheInfo {
            quote_owed_from_lp_pool: i64::MAX / 2,
            last_fee_pool_token_amount: u128::MAX / 2,
            last_net_pnl_pool_token_amount: i128::MAX / 2,
            last_settle_amount: 0,
            last_settle_slot: 0,
            ..Default::default()
        };

        let result = SettlementResult {
            amount_transferred: u64::MAX / 4,
            direction: SettlementDirection::FromLpPool,
            fee_pool_used: 0,
            pnl_pool_used: 0,
        };
        let new_quote_owed = cache.quote_owed_from_lp_pool - (result.amount_transferred as i64);
        let slot = u64::MAX / 2;
        let ts = i64::MAX / 2;

        let update_result = update_cache_info(&mut cache, &result, new_quote_owed, slot, ts);
        assert!(update_result.is_ok());
    }

    #[test]
    fn test_cache_info_update_minimum_values() {
        let mut cache = CacheInfo {
            quote_owed_from_lp_pool: i64::MIN / 2,
            last_fee_pool_token_amount: 1000,
            last_net_pnl_pool_token_amount: i128::MIN / 2,
            last_settle_amount: 0,
            last_settle_slot: 0,
            ..Default::default()
        };

        let result = SettlementResult {
            amount_transferred: 500,
            direction: SettlementDirection::ToLpPool,
            fee_pool_used: 200,
            pnl_pool_used: 300,
        };
        let new_quote_owed = cache.quote_owed_from_lp_pool + (result.amount_transferred as i64);
        let slot = u64::MAX / 2;
        let ts = 42;

        let update_result = update_cache_info(&mut cache, &result, new_quote_owed, slot, ts);
        assert!(update_result.is_ok());
    }

    #[test]
    fn test_sequential_settlement_updates() {
        let mut cache = CacheInfo {
            quote_owed_from_lp_pool: 1000,
            last_fee_pool_token_amount: 5000,
            last_net_pnl_pool_token_amount: 3000,
            last_settle_amount: 0,
            last_settle_slot: 0,
            ..Default::default()
        };

        // First settlement: From LP pool
        let result1 = SettlementResult {
            amount_transferred: 300,
            direction: SettlementDirection::FromLpPool,
            fee_pool_used: 0,
            pnl_pool_used: 0,
        };
        let new_quote_owed1 = cache.quote_owed_from_lp_pool - (result1.amount_transferred as i64);
        update_cache_info(&mut cache, &result1, new_quote_owed1, 101010101, 100).unwrap();

        assert_eq!(cache.quote_owed_from_lp_pool, 700);
        assert_eq!(cache.last_fee_pool_token_amount, 5300);
        assert_eq!(cache.last_net_pnl_pool_token_amount, 3000);

        // Second settlement: To LP pool
        let result2 = SettlementResult {
            amount_transferred: 400,
            direction: SettlementDirection::ToLpPool,
            fee_pool_used: 250,
            pnl_pool_used: 150,
        };
        let new_quote_owed2 = cache.quote_owed_from_lp_pool + (result2.amount_transferred as i64);
        update_cache_info(&mut cache, &result2, new_quote_owed2, 10101010, 200).unwrap();

        assert_eq!(cache.quote_owed_from_lp_pool, 1100);
        assert_eq!(cache.last_fee_pool_token_amount, 5050);
        assert_eq!(cache.last_net_pnl_pool_token_amount, 2850);
        assert_eq!(cache.last_settle_slot, 10101010);
    }

    #[test]
    fn test_perp_to_lp_with_only_pnl_pool() {
        let ctx = SettlementContext {
            quote_owed_from_lp: -1000,
            quote_constituent_token_balance: 2000,
            fee_pool_balance: 0, // No fee pool
            pnl_pool_balance: 1200,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::ToLpPool);
        assert_eq!(result.amount_transferred, 1000);
        assert_eq!(result.fee_pool_used, 0);
        assert_eq!(result.pnl_pool_used, 1000);
    }

    #[test]
    fn test_perp_to_lp_capped_with_max() {
        let ctx = SettlementContext {
            quote_owed_from_lp: -1100,
            quote_constituent_token_balance: 2000,
            fee_pool_balance: 500, // No fee pool
            pnl_pool_balance: 700,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 1000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::ToLpPool);
        assert_eq!(result.amount_transferred, 1000);
        assert_eq!(result.fee_pool_used, 500);
        assert_eq!(result.pnl_pool_used, 500);
    }

    #[test]
    fn test_lp_to_perp_capped_with_max() {
        let ctx = SettlementContext {
            quote_owed_from_lp: 1100,
            quote_constituent_token_balance: 2000,
            fee_pool_balance: 0, // No fee pool
            pnl_pool_balance: 1200,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 1000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::FromLpPool);
        assert_eq!(result.amount_transferred, 1000);
        assert_eq!(result.fee_pool_used, 0);
        assert_eq!(result.pnl_pool_used, 0);
    }

    #[test]
    fn test_perp_to_lp_with_only_fee_pool() {
        let ctx = SettlementContext {
            quote_owed_from_lp: -800,
            quote_constituent_token_balance: 1500,
            fee_pool_balance: 1000,
            pnl_pool_balance: 0, // No PnL pool
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::ToLpPool);
        assert_eq!(result.amount_transferred, 800);
        assert_eq!(result.fee_pool_used, 800);
        assert_eq!(result.pnl_pool_used, 0);
    }

    #[test]
    fn test_fractional_settlement_coverage() {
        // Test when pools can only partially cover the needed amount
        let ctx = SettlementContext {
            quote_owed_from_lp: -2000,
            quote_constituent_token_balance: 5000,
            fee_pool_balance: 300,
            pnl_pool_balance: 500,
            quote_market: &create_mock_spot_market(),
            max_settle_quote_amount: 10000,
        };

        let result = calculate_settlement_amount(&ctx).unwrap();
        assert_eq!(result.direction, SettlementDirection::ToLpPool);
        assert_eq!(result.amount_transferred, 800); // Only what pools can provide
        assert_eq!(result.fee_pool_used, 300);
        assert_eq!(result.pnl_pool_used, 500);
    }

    #[test]
    fn test_settlement_direction_consistency() {
        // Positive quote_owed should always result in FromLpPool or None
        for quote_owed in [1, 100, 1000, 10000] {
            let ctx = SettlementContext {
                quote_owed_from_lp: quote_owed,
                quote_constituent_token_balance: 500,
                fee_pool_balance: 300,
                pnl_pool_balance: 200,
                quote_market: &create_mock_spot_market(),
                max_settle_quote_amount: 10000,
            };

            let result = calculate_settlement_amount(&ctx).unwrap();
            assert!(
                result.direction == SettlementDirection::FromLpPool
                    || result.direction == SettlementDirection::None
            );
        }

        // Negative quote_owed should always result in ToLpPool or None
        for quote_owed in [-1, -100, -1000, -10000] {
            let ctx = SettlementContext {
                quote_owed_from_lp: quote_owed,
                quote_constituent_token_balance: 500,
                fee_pool_balance: 300,
                pnl_pool_balance: 200,
                quote_market: &create_mock_spot_market(),
                max_settle_quote_amount: 10000,
            };

            let result = calculate_settlement_amount(&ctx).unwrap();
            assert!(
                result.direction == SettlementDirection::ToLpPool
                    || result.direction == SettlementDirection::None
            );
        }
    }

    #[test]
    fn test_cache_info_timestamp_progression() {
        let mut cache = CacheInfo::default();

        let timestamps = [1000, 2000, 3000, 1500, 5000]; // Including out-of-order

        for (_, &ts) in timestamps.iter().enumerate() {
            let result = SettlementResult {
                amount_transferred: 100,
                direction: SettlementDirection::FromLpPool,
                fee_pool_used: 0,
                pnl_pool_used: 0,
            };

            update_cache_info(&mut cache, &result, 0, 1010101, ts).unwrap();
            assert_eq!(cache.last_settle_ts, ts);
            assert_eq!(cache.last_settle_amount, 100);
        }
    }

    #[test]
    fn test_settlement_amount_conservation() {
        // Test that fee_pool_used + pnl_pool_used = amount_transferred for ToLpPool
        let test_cases = [
            (-500, 1000, 300, 400),  // Normal case
            (-1000, 2000, 600, 500), // Uses both pools
            (-200, 500, 0, 300),     // Only PnL pool
            (-150, 400, 200, 0),     // Only fee pool
        ];

        for (quote_owed, lp_balance, fee_pool, pnl_pool) in test_cases {
            let ctx = SettlementContext {
                quote_owed_from_lp: quote_owed,
                quote_constituent_token_balance: lp_balance,
                fee_pool_balance: fee_pool,
                pnl_pool_balance: pnl_pool,
                quote_market: &create_mock_spot_market(),
                max_settle_quote_amount: 10000,
            };

            let result = calculate_settlement_amount(&ctx).unwrap();

            if result.direction == SettlementDirection::ToLpPool {
                assert_eq!(
                    result.amount_transferred as u128,
                    result.fee_pool_used + result.pnl_pool_used,
                    "Amount transferred should equal sum of pool usage for case: {:?}",
                    (quote_owed, lp_balance, fee_pool, pnl_pool)
                );
            }
        }
    }

    #[test]
    fn test_cache_pool_balance_tracking() {
        let mut cache = CacheInfo {
            last_fee_pool_token_amount: 1000,
            last_net_pnl_pool_token_amount: 500,
            ..Default::default()
        };

        // Multiple settlements that should maintain balance consistency
        let settlements = [
            (SettlementDirection::ToLpPool, 200, 120, 80), // Uses both pools
            (SettlementDirection::FromLpPool, 150, 0, 0),  // Adds to fee pool
            (SettlementDirection::ToLpPool, 100, 100, 0),  // Uses only fee pool
            (SettlementDirection::ToLpPool, 50, 30, 20),   // Uses both pools again
        ];

        let mut expected_fee_pool = cache.last_fee_pool_token_amount;
        let mut expected_pnl_pool = cache.last_net_pnl_pool_token_amount;

        for (direction, amount, fee_used, pnl_used) in settlements {
            let result = SettlementResult {
                amount_transferred: amount,
                direction,
                fee_pool_used: fee_used,
                pnl_pool_used: pnl_used,
            };

            match direction {
                SettlementDirection::FromLpPool => {
                    expected_fee_pool += amount as u128;
                }
                SettlementDirection::ToLpPool => {
                    expected_fee_pool -= fee_used;
                    expected_pnl_pool -= pnl_used as i128;
                }
                SettlementDirection::None => {}
            }

            update_cache_info(&mut cache, &result, 0, 1000, 0).unwrap();

            assert_eq!(cache.last_fee_pool_token_amount, expected_fee_pool);
            assert_eq!(cache.last_net_pnl_pool_token_amount, expected_pnl_pool);
        }
    }
}

#[cfg(test)]
mod update_aum_tests {
    use crate::{
        create_anchor_account_info,
        math::constants::SPOT_CUMULATIVE_INTEREST_PRECISION,
        math::constants::{PRICE_PRECISION_I64, QUOTE_PRECISION},
        state::amm_cache::{AmmCacheFixed, CacheInfo},
        state::lp_pool::*,
        state::oracle::HistoricalOracleData,
        state::oracle::OracleSource,
        state::spot_market::SpotMarket,
        state::spot_market_map::SpotMarketMap,
        state::zero_copy::AccountZeroCopyMut,
        test_utils::{create_account_info, get_anchor_account_bytes},
    };
    use anchor_lang::prelude::Pubkey;
    use std::{cell::RefCell, marker::PhantomData};

    fn test_aum_with_balances(
        usdc_balance: u64, // USDC balance in tokens (6 decimals)
        sol_balance: u64,  // SOL balance in tokens (9 decimals)
        btc_balance: u64,  // BTC balance in tokens (8 decimals)
        bonk_balance: u64, // BONK balance in tokens (5 decimals)
        expected_aum_usd: u64,
        test_name: &str,
    ) {
        let mut lp_pool = LPPool::default();
        lp_pool.constituents = 4;
        lp_pool.quote_consituent_index = 0;

        // Create constituents with specified token balances
        let mut constituent_usdc = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: 0,
            constituent_index: 0,
            last_oracle_price: PRICE_PRECISION_I64,
            last_oracle_slot: 100,
            decimals: 6,
            vault_token_balance: usdc_balance,
            oracle_staleness_threshold: 10,
            ..Constituent::default()
        };
        create_anchor_account_info!(constituent_usdc, Constituent, constituent_usdc_account_info);

        let mut constituent_sol = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: 1,
            constituent_index: 1,
            last_oracle_price: 200 * PRICE_PRECISION_I64,
            last_oracle_slot: 100,
            decimals: 9,
            vault_token_balance: sol_balance,
            oracle_staleness_threshold: 10,
            ..Constituent::default()
        };
        create_anchor_account_info!(constituent_sol, Constituent, constituent_sol_account_info);

        let mut constituent_btc = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: 2,
            constituent_index: 2,
            last_oracle_price: 100_000 * PRICE_PRECISION_I64,
            last_oracle_slot: 100,
            decimals: 8,
            vault_token_balance: btc_balance,
            oracle_staleness_threshold: 10,
            ..Constituent::default()
        };
        create_anchor_account_info!(constituent_btc, Constituent, constituent_btc_account_info);

        let mut constituent_bonk = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: 3,
            constituent_index: 3,
            last_oracle_price: 22, // $0.000022 in PRICE_PRECISION_I64
            last_oracle_slot: 100,
            decimals: 5,
            vault_token_balance: bonk_balance,
            oracle_staleness_threshold: 10,
            ..Constituent::default()
        };
        create_anchor_account_info!(constituent_bonk, Constituent, constituent_bonk_account_info);

        let constituent_map = ConstituentMap::load_multiple(
            vec![
                &constituent_usdc_account_info,
                &constituent_sol_account_info,
                &constituent_btc_account_info,
                &constituent_bonk_account_info,
            ],
            true,
        )
        .unwrap();

        // Create spot markets
        let mut usdc_spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_spot_market, SpotMarket, usdc_spot_market_account_info);

        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            historical_oracle_data: HistoricalOracleData::default(),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);

        let mut btc_spot_market = SpotMarket {
            market_index: 2,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 8,
            historical_oracle_data: HistoricalOracleData::default(),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(btc_spot_market, SpotMarket, btc_spot_market_account_info);

        let mut bonk_spot_market = SpotMarket {
            market_index: 3,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 5,
            historical_oracle_data: HistoricalOracleData::default(),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(bonk_spot_market, SpotMarket, bonk_spot_market_account_info);

        let spot_market_account_infos = vec![
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
            &btc_spot_market_account_info,
            &bonk_spot_market_account_info,
        ];
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        // Create constituent target base
        let target_fixed = RefCell::new(ConstituentTargetBaseFixed {
            len: 4,
            ..ConstituentTargetBaseFixed::default()
        });
        let target_data = RefCell::new([0u8; 96]); // 4 * 24 bytes per TargetsDatum
        let mut constituent_target_base =
            AccountZeroCopyMut::<'_, TargetsDatum, ConstituentTargetBaseFixed> {
                fixed: target_fixed.borrow_mut(),
                data: target_data.borrow_mut(),
                _marker: PhantomData::<TargetsDatum>,
            };

        // Create AMM cache
        let mut cache_fixed_default = AmmCacheFixed::default();
        cache_fixed_default.len = 0; // No perp markets for this test
        let cache_fixed = RefCell::new(cache_fixed_default);
        let cache_data = RefCell::new([0u8; 0]); // Empty cache data
        let amm_cache = AccountZeroCopyMut::<'_, CacheInfo, AmmCacheFixed> {
            fixed: cache_fixed.borrow_mut(),
            data: cache_data.borrow_mut(),
            _marker: PhantomData::<CacheInfo>,
        };

        // Call update_aum
        let result = lp_pool.update_aum(
            101, // slot
            &constituent_map,
            &spot_market_map,
            &constituent_target_base,
            &amm_cache,
        );

        assert!(result.is_ok(), "{}: update_aum should succeed", test_name);
        let (aum, crypto_delta, derivative_groups) = result.unwrap();

        // Convert expected USD to quote precision
        let expected_aum = expected_aum_usd as u128 * QUOTE_PRECISION;

        println!(
            "{}: AUM = ${}, Expected = ${}",
            test_name,
            aum / QUOTE_PRECISION,
            expected_aum / QUOTE_PRECISION
        );

        // Verify the results (allow small rounding differences)
        let aum_diff = if aum > expected_aum {
            aum - expected_aum
        } else {
            expected_aum - aum
        };
        assert!(
            aum_diff <= QUOTE_PRECISION, // Allow up to $1 difference for rounding
            "{}: AUM mismatch. Got: ${}, Expected: ${}, Diff: ${}",
            test_name,
            aum / QUOTE_PRECISION,
            expected_aum / QUOTE_PRECISION,
            aum_diff / QUOTE_PRECISION
        );

        assert_eq!(crypto_delta, 0, "{}: crypto_delta should be 0", test_name);
        assert!(
            derivative_groups.is_empty(),
            "{}: derivative_groups should be empty",
            test_name
        );

        // Verify LP pool state was updated
        assert_eq!(
            lp_pool.last_aum, aum,
            "{}: last_aum should match calculated AUM",
            test_name
        );
        assert_eq!(
            lp_pool.last_aum_slot, 101,
            "{}: last_aum_slot should be updated",
            test_name
        );
    }

    #[test]
    fn test_aum_zero() {
        test_aum_with_balances(
            0, // 0 USDC
            0, // 0 SOL
            0, // 0 BTC
            0, // 0 BONK
            0, // $0 expected AUM
            "Zero AUM",
        );
    }

    #[test]
    fn test_aum_low_1k() {
        test_aum_with_balances(
            1_000_000_000, // 1,000 USDC (6 decimals) = $1,000
            0,             // 0 SOL
            0,             // 0 BTC
            0,             // 0 BONK
            1_000,         // $1,000 expected AUM
            "Low AUM (~$1k)",
        );
    }

    #[test]
    fn test_aum_reasonable() {
        test_aum_with_balances(
            1_000_000_000_000, // 1M USDC (6 decimals) = $1M
            5_000_000_000_000, // 5k SOL (9 decimals) = $1M at $200/SOL
            800_000_000,       // 8 BTC (8 decimals) = $800k at $100k/BTC
            0,                 // 0 BONK
            2_800_000,         // Expected AUM based on actual calculation
            "Reasonable AUM (~$2.8M)",
        );
    }

    #[test]
    fn test_aum_high() {
        test_aum_with_balances(
            10_000_000_000_000_000,  // 10B USDC (6 decimals) = $10B
            500_000_000_000_000_000, // 500M SOL (9 decimals) = $100B at $200/SOL
            100_000_000_000_000,     // 1M BTC (8 decimals) = $100B at $100k/BTC
            0,                       // 0 BONK
            210_000_000_000,         // Expected AUM based on actual calculation
            "High AUM (~$210b)",
        );
    }

    #[test]
    fn test_aum_with_small_bonk_balance() {
        test_aum_with_balances(
            10_000_000_000_000_000,  // 10B USDC (6 decimals) = $10B
            500_000_000_000_000_000, // 500M SOL (9 decimals) = $100B at $200/SOL
            100_000_000_000_000,     // 1M BTC (8 decimals) = $100B at $100k/BTC
            100_000_000_000_000,     // 1B BONK (5 decimals) = $22k at $0.000022/BONK
            210_000_022_000,         // Expected AUM based on actual calculation
            "High AUM (~$210b) with BONK",
        );
    }

    #[test]
    fn test_aum_with_large_bonk_balance() {
        test_aum_with_balances(
            10_000_000_000_000_000,  // 10B USDC (6 decimals) = $10B
            500_000_000_000_000_000, // 500M SOL (9 decimals) = $100B at $200/SOL
            100_000_000_000_000,     // 1M BTC (8 decimals) = $100B at $100k/BTC
            100_000_000_000_000_000, // 1T BONK (5 decimals) = $22M at $0.000022/BONK
            210_022_000_000,         // Expected AUM based on actual calculation
            "High AUM (~$210b) with BONK",
        );
    }
}

#[cfg(test)]
mod update_constituent_target_base_for_derivatives_tests {
    use super::super::update_constituent_target_base_for_derivatives;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        PERCENTAGE_PRECISION_I64, PERCENTAGE_PRECISION_U64, PRICE_PRECISION_I64, QUOTE_PRECISION,
        SPOT_CUMULATIVE_INTEREST_PRECISION,
    };
    use crate::state::constituent_map::ConstituentMap;
    use crate::state::lp_pool::{Constituent, ConstituentTargetBaseFixed, TargetsDatum};
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::spot_market::SpotMarket;
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::zero_copy::AccountZeroCopyMut;
    use crate::test_utils::{create_account_info, get_anchor_account_bytes};
    use anchor_lang::prelude::Pubkey;
    use anchor_lang::Owner;
    use std::collections::BTreeMap;
    use std::{cell::RefCell, marker::PhantomData};

    fn test_derivative_weights_scenario(
        derivative_weights: Vec<u64>,
        test_name: &str,
        should_succeed: bool,
    ) {
        let aum = 10_000_000 * QUOTE_PRECISION; // $10M AUM

        // Create parent constituent (SOL) - parent_index must not be 0
        let parent_index = 1u16;
        let mut parent_constituent = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: parent_index,
            constituent_index: parent_index,
            last_oracle_price: 200 * PRICE_PRECISION_I64, // $200 SOL
            last_oracle_slot: 100,
            decimals: 9,
            constituent_derivative_index: -1, // Parent index
            derivative_weight: 0,             // Parent doesn't have derivative weight
            constituent_derivative_depeg_threshold: 950_000, // 95% threshold
            ..Constituent::default()
        };
        create_anchor_account_info!(
            parent_constituent,
            Constituent,
            parent_constituent_account_info
        );

        // Create first derivative constituent
        let derivative1_index = parent_index + 1; // 2
        let mut derivative1_constituent = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: derivative1_index,
            constituent_index: derivative1_index,
            last_oracle_price: 195 * PRICE_PRECISION_I64, // $195 (slightly below parent)
            last_oracle_slot: 100,
            decimals: 9,
            constituent_derivative_index: parent_index as i16,
            derivative_weight: derivative_weights.get(0).map(|w| *w).unwrap_or(0),
            constituent_derivative_depeg_threshold: 950_000, // 95% threshold
            ..Constituent::default()
        };
        create_anchor_account_info!(
            derivative1_constituent,
            Constituent,
            derivative1_constituent_account_info
        );

        // Create second derivative constituent
        let derivative2_index = parent_index + 2; // 3
        let mut derivative2_constituent = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: derivative2_index,
            constituent_index: derivative2_index,
            last_oracle_price: 205 * PRICE_PRECISION_I64, // $205 (slightly above parent)
            last_oracle_slot: 100,
            decimals: 9,
            constituent_derivative_index: parent_index as i16,
            derivative_weight: derivative_weights.get(1).map(|w| *w).unwrap_or(0),
            constituent_derivative_depeg_threshold: 950_000, // 95% threshold
            ..Constituent::default()
        };
        create_anchor_account_info!(
            derivative2_constituent,
            Constituent,
            derivative2_constituent_account_info
        );

        // Create third derivative constituent
        let derivative3_index = parent_index + 3; // 4
        let mut derivative3_constituent = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: derivative3_index,
            constituent_index: derivative3_index,
            last_oracle_price: 210 * PRICE_PRECISION_I64, // $210 (slightly above parent)
            last_oracle_slot: 100,
            decimals: 9,
            constituent_derivative_index: parent_index as i16,
            derivative_weight: derivative_weights.get(2).map(|w| *w).unwrap_or(0),
            constituent_derivative_depeg_threshold: 950_000, // 95% threshold
            ..Constituent::default()
        };
        create_anchor_account_info!(
            derivative3_constituent,
            Constituent,
            derivative3_constituent_account_info
        );

        let constituents_list = vec![
            &parent_constituent_account_info,
            &derivative1_constituent_account_info,
            &derivative2_constituent_account_info,
            &derivative3_constituent_account_info,
        ];
        let constituent_map = ConstituentMap::load_multiple(constituents_list, true).unwrap();

        // Create spot markets
        let mut parent_spot_market = SpotMarket {
            market_index: parent_index,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            historical_oracle_data: HistoricalOracleData::default(),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(
            parent_spot_market,
            SpotMarket,
            parent_spot_market_account_info
        );

        let mut derivative1_spot_market = SpotMarket {
            market_index: derivative1_index,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            historical_oracle_data: HistoricalOracleData::default(),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(
            derivative1_spot_market,
            SpotMarket,
            derivative1_spot_market_account_info
        );

        let mut derivative2_spot_market = SpotMarket {
            market_index: derivative2_index,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            historical_oracle_data: HistoricalOracleData::default(),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(
            derivative2_spot_market,
            SpotMarket,
            derivative2_spot_market_account_info
        );

        let mut derivative3_spot_market = SpotMarket {
            market_index: derivative3_index,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            historical_oracle_data: HistoricalOracleData::default(),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(
            derivative3_spot_market,
            SpotMarket,
            derivative3_spot_market_account_info
        );

        let spot_market_list = vec![
            &parent_spot_market_account_info,
            &derivative1_spot_market_account_info,
            &derivative2_spot_market_account_info,
            &derivative3_spot_market_account_info,
        ];
        let spot_market_map = SpotMarketMap::load_multiple(spot_market_list, true).unwrap();

        // Create constituent target base
        let num_constituents = 4; // Fixed: parent + 3 derivatives
        let target_fixed = RefCell::new(ConstituentTargetBaseFixed {
            len: num_constituents as u32,
            ..ConstituentTargetBaseFixed::default()
        });
        let target_data = RefCell::new([0u8; 120]); // 4+1 constituents * 24 bytes per TargetsDatum
        let mut constituent_target_base =
            AccountZeroCopyMut::<'_, TargetsDatum, ConstituentTargetBaseFixed> {
                fixed: target_fixed.borrow_mut(),
                data: target_data.borrow_mut(),
                _marker: PhantomData::<TargetsDatum>,
            };

        // Set initial parent target base (targeting 10% of total AUM worth of SOL tokens)
        // For 10M AUM and $200 SOL price with 9 decimals: (10M * 0.1) / 200 * 10^9 = 5,000,000,000,000 tokens
        let initial_parent_target_base = 5_000_000_000_000i64; // ~$1M worth of SOL tokens
        constituent_target_base
            .get_mut(parent_index as u32)
            .target_base = initial_parent_target_base;
        constituent_target_base
            .get_mut(parent_index as u32)
            .last_slot = 100;

        // Initialize derivative target bases to 0
        constituent_target_base
            .get_mut(derivative1_index as u32)
            .target_base = 0;
        constituent_target_base
            .get_mut(derivative1_index as u32)
            .last_slot = 100;
        constituent_target_base
            .get_mut(derivative2_index as u32)
            .target_base = 0;
        constituent_target_base
            .get_mut(derivative2_index as u32)
            .last_slot = 100;
        constituent_target_base
            .get_mut(derivative3_index as u32)
            .target_base = 0;
        constituent_target_base
            .get_mut(derivative3_index as u32)
            .last_slot = 100;

        // Create derivative groups
        let mut derivative_groups = BTreeMap::new();
        let mut active_derivatives = Vec::new();
        for (i, _) in derivative_weights.iter().enumerate() {
            // Add all derivatives regardless of weight (they may have zero weight for testing)
            let derivative_index = match i {
                0 => derivative1_index,
                1 => derivative2_index,
                2 => derivative3_index,
                _ => continue,
            };
            active_derivatives.push(derivative_index);
        }
        if !active_derivatives.is_empty() {
            derivative_groups.insert(parent_index, active_derivatives);
        }

        // Call the function
        let result = update_constituent_target_base_for_derivatives(
            aum,
            &derivative_groups,
            &constituent_map,
            &spot_market_map,
            &mut constituent_target_base,
        );

        assert!(
            result.is_ok() == should_succeed,
            "{}: update_constituent_target_base_for_derivatives should succeed",
            test_name
        );

        if !should_succeed {
            return;
        }

        // Verify results
        let parent_target_base_after = constituent_target_base.get(parent_index as u32).target_base;
        let total_derivative_weight: u64 = derivative_weights.iter().sum();
        let remaining_parent_weight = PERCENTAGE_PRECISION_U64 - total_derivative_weight;

        // Expected parent target base after scaling down
        let expected_parent_target_base = initial_parent_target_base
            * (remaining_parent_weight as i64)
            / (PERCENTAGE_PRECISION_I64);

        println!(
            "{}: Original parent target base: {}, After: {}, Expected: {}",
            test_name,
            initial_parent_target_base,
            parent_target_base_after,
            expected_parent_target_base
        );

        assert_eq!(
            parent_target_base_after, expected_parent_target_base,
            "{}: Parent target base should be scaled down correctly",
            test_name
        );

        // Verify derivative target bases
        for (i, derivative_weight) in derivative_weights.iter().enumerate() {
            let derivative_index = match i {
                0 => derivative1_index,
                1 => derivative2_index,
                2 => derivative3_index,
                _ => continue,
            };

            let derivative_target_base = constituent_target_base
                .get(derivative_index as u32)
                .target_base;

            if *derivative_weight == 0 {
                // If derivative weight is 0, target base should remain 0
                assert_eq!(
                    derivative_target_base, 0,
                    "{}: Derivative {} with zero weight should have target base 0",
                    test_name, derivative_index
                );
                continue;
            }

            // For simplicity, just verify that the derivative target base is positive and reasonable
            // The exact calculation is complex and depends on the internal implementation
            println!(
                "{}: Derivative {} target base: {}, Weight: {}",
                test_name, derivative_index, derivative_target_base, derivative_weight
            );

            assert!(
                derivative_target_base > 0,
                "{}: Derivative {} target base should be positive",
                test_name,
                derivative_index
            );

            // Verify that target base is reasonable (not too large or too small)
            assert!(
                derivative_target_base < 10_000_000_000_000i64,
                "{}: Derivative {} target base should be reasonable",
                test_name,
                derivative_index
            );
        }
    }

    fn test_depeg_scenario() {
        let aum = 10_000_000 * QUOTE_PRECISION; // $10M AUM

        // Create parent constituent (SOL) - parent_index must not be 0
        let parent_index = 1u16;
        let mut parent_constituent = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: parent_index,
            constituent_index: parent_index,
            last_oracle_price: 200 * PRICE_PRECISION_I64, // $200 SOL
            last_oracle_slot: 100,
            decimals: 9,
            constituent_derivative_index: -1, // Parent index
            derivative_weight: 0,
            constituent_derivative_depeg_threshold: 950_000, // 95% threshold
            ..Constituent::default()
        };
        create_anchor_account_info!(
            parent_constituent,
            Constituent,
            parent_constituent_account_info
        );

        // Create derivative constituent that's depegged - must have different index than parent
        let derivative_index = parent_index + 1; // 2
        let mut derivative_constituent = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: derivative_index,
            constituent_index: derivative_index,
            last_oracle_price: 180 * PRICE_PRECISION_I64, // $180 (below 95% threshold)
            last_oracle_slot: 100,
            decimals: 9,
            constituent_derivative_index: parent_index as i16,
            derivative_weight: 500_000,                      // 50% weight
            constituent_derivative_depeg_threshold: 950_000, // 95% threshold
            ..Constituent::default()
        };
        create_anchor_account_info!(
            derivative_constituent,
            Constituent,
            derivative_constituent_account_info
        );

        let constituent_map = ConstituentMap::load_multiple(
            vec![
                &parent_constituent_account_info,
                &derivative_constituent_account_info,
            ],
            true,
        )
        .unwrap();

        // Create spot markets
        let mut parent_spot_market = SpotMarket {
            market_index: parent_index,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(
            parent_spot_market,
            SpotMarket,
            parent_spot_market_account_info
        );

        let mut derivative_spot_market = SpotMarket {
            market_index: derivative_index,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(
            derivative_spot_market,
            SpotMarket,
            derivative_spot_market_account_info
        );

        let spot_market_map = SpotMarketMap::load_multiple(
            vec![
                &parent_spot_market_account_info,
                &derivative_spot_market_account_info,
            ],
            true,
        )
        .unwrap();

        // Create constituent target base
        let target_fixed = RefCell::new(ConstituentTargetBaseFixed {
            len: 2,
            ..ConstituentTargetBaseFixed::default()
        });
        let target_data = RefCell::new([0u8; 72]); // 2+1 constituents * 24 bytes per TargetsDatum
        let mut constituent_target_base =
            AccountZeroCopyMut::<'_, TargetsDatum, ConstituentTargetBaseFixed> {
                fixed: target_fixed.borrow_mut(),
                data: target_data.borrow_mut(),
                _marker: PhantomData::<TargetsDatum>,
            };

        // Set initial values
        constituent_target_base
            .get_mut(parent_index as u32)
            .target_base = 2_500_000_000_000i64; // ~$500k worth of SOL
        constituent_target_base
            .get_mut(derivative_index as u32)
            .target_base = 1_250_000_000_000i64; // ~$250k worth

        // Create derivative groups
        let mut derivative_groups = BTreeMap::new();
        derivative_groups.insert(parent_index, vec![derivative_index]);

        // Call the function
        let result = update_constituent_target_base_for_derivatives(
            aum,
            &derivative_groups,
            &constituent_map,
            &spot_market_map,
            &mut constituent_target_base,
        );

        assert!(
            result.is_ok(),
            "depeg scenario: update_constituent_target_base_for_derivatives should succeed"
        );

        // Verify that depegged derivative has target base set to 0
        let derivative_target_base = constituent_target_base
            .get(derivative_index as u32)
            .target_base;
        assert_eq!(
            derivative_target_base, 0,
            "depeg scenario: Depegged derivative should have target base 0"
        );

        // Verify that parent target base is unchanged since derivative weight is 0 now
        let parent_target_base = constituent_target_base.get(parent_index as u32).target_base;
        assert_eq!(
            parent_target_base, 2_500_000_000_000i64,
            "depeg scenario: Parent target base should remain unchanged"
        );
    }

    #[test]
    fn test_derivative_depeg_scenario() {
        // Test case: Test depeg scenario
        test_depeg_scenario();
    }

    #[test]
    fn test_derivative_weights_sum_to_110_percent() {
        // Test case: Derivative constituents with weights that sum to 1.1 (110%)
        test_derivative_weights_scenario(
            vec![
                500_000, // 50% weight
                300_000, // 30% weight
                300_000, // 30% weight
            ],
            "weights sum to 110%",
            false,
        );
    }

    #[test]
    fn test_derivative_weights_sum_to_100_percent() {
        // Test case: Derivative constituents with weights that sum to 1 (100%)
        test_derivative_weights_scenario(
            vec![
                500_000, // 50% weight
                300_000, // 30% weight
                200_000, // 20% weight
            ],
            "weights sum to 100%",
            true,
        );
    }

    #[test]
    fn test_derivative_weights_sum_to_75_percent() {
        // Test case: Derivative constituents with weights that sum to < 1 (75%)
        test_derivative_weights_scenario(
            vec![
                400_000, // 40% weight
                200_000, // 20% weight
                150_000, // 15% weight
            ],
            "weights sum to 75%",
            true,
        );
    }

    #[test]
    fn test_single_derivative_60_percent_weight() {
        // Test case: Single derivative with partial weight
        test_derivative_weights_scenario(
            vec![
                600_000, // 60% weight
            ],
            "single derivative 60% weight",
            true,
        );
    }

    #[test]
    fn test_single_derivative_100_percent_weight() {
        // Test case: Single derivative with 100% weight - parent should become 0
        test_derivative_weights_scenario(
            vec![
                1_000_000, // 100% weight
            ],
            "single derivative 100% weight",
            true,
        );
    }

    #[test]
    fn test_mixed_zero_and_nonzero_weights() {
        // Test case: Mix of zero and non-zero weights
        test_derivative_weights_scenario(
            vec![
                0,       // 0% weight
                400_000, // 40% weight
                0,       // 0% weight
            ],
            "mixed zero and non-zero weights",
            true,
        );
    }

    #[test]
    fn test_very_small_weights() {
        // Test case: Very small weights (1 basis point = 0.01%)
        test_derivative_weights_scenario(
            vec![
                100, // 0.01% weight
                200, // 0.02% weight
                300, // 0.03% weight
            ],
            "very small weights",
            true,
        );
    }

    #[test]
    fn test_zero_parent_target_base() {
        let aum = 10_000_000 * QUOTE_PRECISION; // $10M AUM

        let parent_index = 1u16;
        let mut parent_constituent = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: parent_index,
            constituent_index: parent_index,
            last_oracle_price: 200 * PRICE_PRECISION_I64,
            last_oracle_slot: 100,
            decimals: 9,
            constituent_derivative_index: -1,
            derivative_weight: 0,
            constituent_derivative_depeg_threshold: 950_000,
            ..Constituent::default()
        };
        create_anchor_account_info!(
            parent_constituent,
            Constituent,
            parent_constituent_account_info
        );

        let derivative_index = parent_index + 1;
        let mut derivative_constituent = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: derivative_index,
            constituent_index: derivative_index,
            last_oracle_price: 195 * PRICE_PRECISION_I64,
            last_oracle_slot: 100,
            decimals: 9,
            constituent_derivative_index: parent_index as i16,
            derivative_weight: 500_000, // 50% weight
            constituent_derivative_depeg_threshold: 950_000,
            ..Constituent::default()
        };
        create_anchor_account_info!(
            derivative_constituent,
            Constituent,
            derivative_constituent_account_info
        );

        let constituent_map = ConstituentMap::load_multiple(
            vec![
                &parent_constituent_account_info,
                &derivative_constituent_account_info,
            ],
            true,
        )
        .unwrap();

        let mut parent_spot_market = SpotMarket {
            market_index: parent_index,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(
            parent_spot_market,
            SpotMarket,
            parent_spot_market_account_info
        );

        let mut derivative_spot_market = SpotMarket {
            market_index: derivative_index,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(
            derivative_spot_market,
            SpotMarket,
            derivative_spot_market_account_info
        );

        let spot_market_map = SpotMarketMap::load_multiple(
            vec![
                &parent_spot_market_account_info,
                &derivative_spot_market_account_info,
            ],
            true,
        )
        .unwrap();

        let target_fixed = RefCell::new(ConstituentTargetBaseFixed {
            len: 2,
            ..ConstituentTargetBaseFixed::default()
        });
        let target_data = RefCell::new([0u8; 72]);
        let mut constituent_target_base =
            AccountZeroCopyMut::<'_, TargetsDatum, ConstituentTargetBaseFixed> {
                fixed: target_fixed.borrow_mut(),
                data: target_data.borrow_mut(),
                _marker: PhantomData::<TargetsDatum>,
            };

        // Set parent target base to 0
        constituent_target_base
            .get_mut(parent_index as u32)
            .target_base = 0i64;
        constituent_target_base
            .get_mut(derivative_index as u32)
            .target_base = 0i64;

        let mut derivative_groups = BTreeMap::new();
        derivative_groups.insert(parent_index, vec![derivative_index]);

        let result = update_constituent_target_base_for_derivatives(
            aum,
            &derivative_groups,
            &constituent_map,
            &spot_market_map,
            &mut constituent_target_base,
        );

        assert!(
            result.is_ok(),
            "zero parent target base scenario should succeed"
        );

        // With zero parent target base, derivative should also be 0
        let derivative_target_base = constituent_target_base
            .get(derivative_index as u32)
            .target_base;
        assert_eq!(
            derivative_target_base, 0,
            "zero parent target base: derivative target base should be 0"
        );
    }

    #[test]
    fn test_mixed_depegged_and_valid_derivatives() {
        let aum = 10_000_000 * QUOTE_PRECISION; // $10M AUM

        let parent_index = 1u16;
        let mut parent_constituent = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: parent_index,
            constituent_index: parent_index,
            last_oracle_price: 200 * PRICE_PRECISION_I64, // $200
            last_oracle_slot: 100,
            decimals: 9,
            constituent_derivative_index: -1,
            derivative_weight: 0,
            constituent_derivative_depeg_threshold: 949_999, // 95% threshold
            ..Constituent::default()
        };
        create_anchor_account_info!(
            parent_constituent,
            Constituent,
            parent_constituent_account_info
        );

        // First derivative - depegged
        let derivative1_index = parent_index + 1;
        let mut derivative1_constituent = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: derivative1_index,
            constituent_index: derivative1_index,
            last_oracle_price: 180 * PRICE_PRECISION_I64, // $180 (below 95% threshold)
            last_oracle_slot: 100,
            decimals: 9,
            constituent_derivative_index: parent_index as i16,
            derivative_weight: 300_000, // 30% weight
            constituent_derivative_depeg_threshold: 950_000,
            ..Constituent::default()
        };
        create_anchor_account_info!(
            derivative1_constituent,
            Constituent,
            derivative1_constituent_account_info
        );

        // Second derivative - valid
        let derivative2_index = parent_index + 2;
        let mut derivative2_constituent = Constituent {
            mint: Pubkey::new_unique(),
            spot_market_index: derivative2_index,
            constituent_index: derivative2_index,
            last_oracle_price: 198 * PRICE_PRECISION_I64, // $198 (above 95% threshold)
            last_oracle_slot: 100,
            decimals: 9,
            constituent_derivative_index: parent_index as i16,
            derivative_weight: 400_000, // 40% weight
            constituent_derivative_depeg_threshold: 950_000,
            ..Constituent::default()
        };
        create_anchor_account_info!(
            derivative2_constituent,
            Constituent,
            derivative2_constituent_account_info
        );

        let constituent_map = ConstituentMap::load_multiple(
            vec![
                &parent_constituent_account_info,
                &derivative1_constituent_account_info,
                &derivative2_constituent_account_info,
            ],
            true,
        )
        .unwrap();

        let mut parent_spot_market = SpotMarket {
            market_index: parent_index,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(
            parent_spot_market,
            SpotMarket,
            parent_spot_market_account_info
        );

        let mut derivative1_spot_market = SpotMarket {
            market_index: derivative1_index,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(
            derivative1_spot_market,
            SpotMarket,
            derivative1_spot_market_account_info
        );

        let mut derivative2_spot_market = SpotMarket {
            market_index: derivative2_index,
            oracle_source: OracleSource::Pyth,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(
            derivative2_spot_market,
            SpotMarket,
            derivative2_spot_market_account_info
        );

        let spot_market_map = SpotMarketMap::load_multiple(
            vec![
                &parent_spot_market_account_info,
                &derivative1_spot_market_account_info,
                &derivative2_spot_market_account_info,
            ],
            true,
        )
        .unwrap();

        let target_fixed = RefCell::new(ConstituentTargetBaseFixed {
            len: 3,
            ..ConstituentTargetBaseFixed::default()
        });
        let target_data = RefCell::new([0u8; 96]);
        let mut constituent_target_base =
            AccountZeroCopyMut::<'_, TargetsDatum, ConstituentTargetBaseFixed> {
                fixed: target_fixed.borrow_mut(),
                data: target_data.borrow_mut(),
                _marker: PhantomData::<TargetsDatum>,
            };

        constituent_target_base
            .get_mut(parent_index as u32)
            .target_base = 5_000_000_000_000i64;
        constituent_target_base
            .get_mut(derivative1_index as u32)
            .target_base = 0i64;
        constituent_target_base
            .get_mut(derivative2_index as u32)
            .target_base = 0i64;

        let mut derivative_groups = BTreeMap::new();
        derivative_groups.insert(parent_index, vec![derivative1_index, derivative2_index]);

        let result = update_constituent_target_base_for_derivatives(
            aum,
            &derivative_groups,
            &constituent_map,
            &spot_market_map,
            &mut constituent_target_base,
        );

        assert!(
            result.is_ok(),
            "mixed depegged and valid derivatives scenario should succeed"
        );

        // First derivative should be depegged (target base = 0)
        let derivative1_target_base = constituent_target_base
            .get(derivative1_index as u32)
            .target_base;
        assert_eq!(
            derivative1_target_base, 0,
            "mixed scenario: depegged derivative should have target base 0"
        );

        // Second derivative should have positive target base
        let derivative2_target_base = constituent_target_base
            .get(derivative2_index as u32)
            .target_base;
        assert!(
            derivative2_target_base > 0,
            "mixed scenario: valid derivative should have positive target base"
        );

        // Parent should be scaled down by only the valid derivative's weight (40%)
        let parent_target_base = constituent_target_base.get(parent_index as u32).target_base;
        let expected_parent_target_base = 5_000_000_000_000i64 * (1_000_000 - 400_000) / 1_000_000;
        assert_eq!(
            parent_target_base, expected_parent_target_base,
            "mixed scenario: parent should be scaled by valid derivative weight only"
        );
    }
}
