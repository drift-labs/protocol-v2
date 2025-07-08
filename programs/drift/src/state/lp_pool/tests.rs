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

        let amm_inventory_and_price: Vec<(u16, i64, i64)> = vec![
            (0, 4 * BASE_PRECISION_I64, 100_000 * PRICE_PRECISION_I64), // $400k BTC
            (1, 2000 * BASE_PRECISION_I64, 200 * PRICE_PRECISION_I64),  // $400k SOL
            (2, 200 * BASE_PRECISION_I64, 1500 * PRICE_PRECISION_I64),  // $300k ETH
            (3, 16500 * BASE_PRECISION_I64, PRICE_PRECISION_I64),       // $16.5k FARTCOIN
        ];
        let constituents_indexes_and_decimals_and_prices = vec![
            (0, 6, 100_000 * PRICE_PRECISION_I64),
            (1, 6, 200 * PRICE_PRECISION_I64),
            (2, 6, 1500 * PRICE_PRECISION_I64),
            (3, 6, PRICE_PRECISION_I64), // USDC
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

        let target_base = target_zc_mut
            .update_target_base(
                &mapping_zc,
                &amm_inventory_and_price,
                &constituents_indexes_and_decimals_and_prices,
                now_ts,
            )
            .unwrap();

        msg!("Target Base: {:?}", target_base);

        let target_weights: Vec<i64> = target_base
            .iter()
            .enumerate()
            .map(|(index, base)| {
                calculate_target_weight(
                    base.cast::<i64>().unwrap(),
                    &SpotMarket::default_quote_market(),
                    amm_inventory_and_price.get(index).unwrap().2,
                    aum,
                    WeightValidationFlags::NONE,
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

        let amm_inventory_and_prices: Vec<(u16, i64, i64)> = vec![(0, 1_000_000, 1_000_000)];
        let constituents_indexes_and_decimals_and_prices = vec![(1, 6, 1_000_000)];
        let aum = 1_000_000;
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

        let totalw = target_zc_mut
            .update_target_base(
                &mapping_zc,
                &amm_inventory_and_prices,
                &constituents_indexes_and_decimals_and_prices,
                now_ts,
            )
            .unwrap();

        assert!(totalw.iter().all(|&x| x == 0));
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
        let amm_inventory_and_prices: Vec<(u16, i64, i64)> = vec![(0, BASE_PRECISION_I64, price)];
        let constituents_indexes_and_decimals_and_prices = vec![(1, 6, price)];
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

        let base = target_zc_mut
            .update_target_base(
                &mapping_zc,
                &amm_inventory_and_prices,
                &constituents_indexes_and_decimals_and_prices,
                now_ts,
            )
            .unwrap();

        let weight = calculate_target_weight(
            *base.get(0).unwrap() as i64,
            &SpotMarket::default(),
            price,
            aum,
            WeightValidationFlags::NONE,
        )
        .unwrap();

        assert_eq!(*base.get(0).unwrap(), -1 * 10_i128.pow(6_u32));
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

        let amm_inventory_and_prices: Vec<(u16, i64, i64)> = vec![(0, 1_000_000_000, 1_000_000)];
        let constituents_indexes_and_decimals_and_prices =
            vec![(1, 6, 1_000_000), (2, 6, 1_000_000)];

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
                &constituents_indexes_and_decimals_and_prices,
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
                        .2,
                    aum,
                    WeightValidationFlags::NONE
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

        let amm_inventory_and_prices: Vec<(u16, i64, i64)> = vec![(0, 1_000_000, 142_000_000)];
        let constituents_indexes_and_decimals_and_prices = vec![(1, 6, 142_000_000)];

        let prices = vec![142_000_000];
        let aum = 0;
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
                &constituents_indexes_and_decimals_and_prices,
                now_ts,
            )
            .unwrap();

        assert_eq!(target_zc_mut.len(), 1);
        assert_eq!(target_zc_mut.get(0).target_base, -1_000); // despite no aum, desire to reach target
        assert_eq!(target_zc_mut.get(0).last_slot, now_ts);
    }

    #[test]
    fn test_constituent_fee_to_charge() {
        let mut constituent = Constituent::default();
        constituent.swap_fee_min = PERCENTAGE_PRECISION_I64 / 10000; // 1 bps
        constituent.swap_fee_max = PERCENTAGE_PRECISION_I64 / 1000; // 10 bps;
        constituent.max_weight_deviation = PERCENTAGE_PRECISION_I64 / 10; // max 10% deviation from target

        // target weight is 50%, push the Constituent to 40% (max below target)
        let fee = constituent
            .get_fee_to_charge(
                PERCENTAGE_PRECISION_I64 * 40 / 100,
                PERCENTAGE_PRECISION_I64 / 2,
            )
            .unwrap();
        assert_eq!(fee, PERCENTAGE_PRECISION_I64 / 1000); // 10 bps

        // target weight is 50%, push the Constituent to 60% (max above target)
        let fee = constituent
            .get_fee_to_charge(
                PERCENTAGE_PRECISION_I64 * 60 / 100,
                PERCENTAGE_PRECISION_I64 / 2,
            )
            .unwrap();
        assert_eq!(fee, PERCENTAGE_PRECISION_I64 / 1000); // 10 bps

        // target weight is 50%, push the Constituent to 45% (half to min target)
        let fee = constituent
            .get_fee_to_charge(
                PERCENTAGE_PRECISION_I64 * 45 / 100,
                PERCENTAGE_PRECISION_I64 / 2,
            )
            .unwrap();
        assert_eq!(fee, PERCENTAGE_PRECISION_I64 * 55 / 100000); // 5.5 bps

        // target weight is 50%, push the Constituent to 55% (half to max target)
        let fee = constituent
            .get_fee_to_charge(
                PERCENTAGE_PRECISION_I64 * 55 / 100,
                PERCENTAGE_PRECISION_I64 / 2,
            )
            .unwrap();
        assert_eq!(fee, PERCENTAGE_PRECISION_I64 * 55 / 100000); // 5.5 bps

        // target weight is 50%, push the Constituent to 50% (target)
        let fee = constituent
            .get_fee_to_charge(
                PERCENTAGE_PRECISION_I64 * 50 / 100,
                PERCENTAGE_PRECISION_I64 / 2,
            )
            .unwrap();
        assert_eq!(fee, PERCENTAGE_PRECISION_I64 / 10000); // 1 bps (min fee)
    }
}

#[cfg(test)]
mod swap_tests {
    use crate::math::constants::{
        PERCENTAGE_PRECISION, PERCENTAGE_PRECISION_I64, PRICE_PRECISION_I64, SPOT_BALANCE_PRECISION,
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
            token_balance: in_token_amount as u64,
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
            token_balance: out_token_amount as u64,
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
            281448778,
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
    fn test_get_fee_to_charge_positive_min_fee() {
        let c = Constituent {
            swap_fee_min: PERCENTAGE_PRECISION_I64 / 10000, // 1 bps
            swap_fee_max: PERCENTAGE_PRECISION_I64 / 100,   // 100 bps
            max_weight_deviation: PERCENTAGE_PRECISION_I64 / 10, // 10%
            ..Constituent::default()
        };

        // swapping to target should incur minimum fee
        let target_weight = PERCENTAGE_PRECISION_I64 / 2; // 50%
        let post_swap_weight = target_weight; // 50%
        let fee = c
            .get_fee_to_charge(post_swap_weight, target_weight)
            .unwrap();
        assert_eq!(fee, c.swap_fee_min);

        // positive target: swapping to max deviation above target should incur maximum fee
        let post_swap_weight = target_weight + c.max_weight_deviation;
        let fee = c
            .get_fee_to_charge(post_swap_weight, target_weight)
            .unwrap();
        assert_eq!(fee, c.swap_fee_max);

        // positive target: swapping to max deviation below target should incur minimum fee
        let post_swap_weight = target_weight - c.max_weight_deviation;
        let fee = c
            .get_fee_to_charge(post_swap_weight, target_weight)
            .unwrap();
        assert_eq!(fee, c.swap_fee_max);

        // negative target: swapping to max deviation above target should incur maximum fee
        let post_swap_weight = -1 * target_weight + c.max_weight_deviation;
        let fee = c
            .get_fee_to_charge(post_swap_weight, -1 * target_weight)
            .unwrap();
        assert_eq!(fee, c.swap_fee_max);

        // negative target: swapping to max deviation below target should incur minimum fee
        let post_swap_weight = -1 * target_weight - c.max_weight_deviation;
        let fee = c
            .get_fee_to_charge(post_swap_weight, -1 * target_weight)
            .unwrap();
        assert_eq!(fee, c.swap_fee_max);

        // positive target: swaps to +max_weight_deviation/2, should incur half of the max fee
        let post_swap_weight = target_weight + c.max_weight_deviation / 2;
        let fee = c
            .get_fee_to_charge(post_swap_weight, target_weight)
            .unwrap();
        assert_eq!(fee, (c.swap_fee_max + c.swap_fee_min) / 2);

        // positive target: swaps to -max_weight_deviation/2, should incur half of the max fee
        let post_swap_weight = target_weight - c.max_weight_deviation / 2;
        let fee = c
            .get_fee_to_charge(post_swap_weight, target_weight)
            .unwrap();
        assert_eq!(fee, (c.swap_fee_max + c.swap_fee_min) / 2);

        // negative target: swaps to +max_weight_deviation/2, should incur half of the max fee
        let post_swap_weight = -1 * target_weight + c.max_weight_deviation / 2;
        let fee = c
            .get_fee_to_charge(post_swap_weight, -1 * target_weight)
            .unwrap();
        assert_eq!(fee, (c.swap_fee_max + c.swap_fee_min) / 2);

        // negative target: swaps to -max_weight_deviation/2, should incur half of the max fee
        let post_swap_weight = -1 * target_weight - c.max_weight_deviation / 2;
        let fee = c
            .get_fee_to_charge(post_swap_weight, -1 * target_weight)
            .unwrap();
        assert_eq!(fee, (c.swap_fee_max + c.swap_fee_min) / 2);
    }

    #[test]
    fn test_get_fee_to_charge_negative_min_fee() {
        let c = Constituent {
            swap_fee_min: -1 * PERCENTAGE_PRECISION_I64 / 10000, // -1 bps (rebate)
            swap_fee_max: PERCENTAGE_PRECISION_I64 / 100,        // 100 bps
            max_weight_deviation: PERCENTAGE_PRECISION_I64 / 10, // 10%
            ..Constituent::default()
        };

        // swapping to target should incur minimum fee
        let target_weight = PERCENTAGE_PRECISION_I64 / 2; // 50%
        let post_swap_weight = target_weight; // 50%
        let fee = c
            .get_fee_to_charge(post_swap_weight, target_weight)
            .unwrap();
        assert_eq!(fee, c.swap_fee_min);

        // positive target: swapping to max deviation above target should incur maximum fee
        let post_swap_weight = target_weight + c.max_weight_deviation;
        let fee = c
            .get_fee_to_charge(post_swap_weight, target_weight)
            .unwrap();
        assert_eq!(fee, c.swap_fee_max);

        // positive target: swapping to max deviation below target should incur minimum fee
        let post_swap_weight = target_weight - c.max_weight_deviation;
        let fee = c
            .get_fee_to_charge(post_swap_weight, target_weight)
            .unwrap();
        assert_eq!(fee, c.swap_fee_max);

        // negative target: swapping to max deviation above target should incur maximum fee
        let post_swap_weight = -1 * target_weight + c.max_weight_deviation;
        let fee = c
            .get_fee_to_charge(post_swap_weight, -1 * target_weight)
            .unwrap();
        assert_eq!(fee, c.swap_fee_max);

        // negative target: swapping to max deviation below target should incur minimum fee
        let post_swap_weight = -1 * target_weight - c.max_weight_deviation;
        let fee = c
            .get_fee_to_charge(post_swap_weight, -1 * target_weight)
            .unwrap();
        assert_eq!(fee, c.swap_fee_max);

        // positive target: swaps to +max_weight_deviation/2, should incur half of the max fee
        let post_swap_weight = target_weight + c.max_weight_deviation / 2;
        let fee = c
            .get_fee_to_charge(post_swap_weight, target_weight)
            .unwrap();
        assert_eq!(fee, (c.swap_fee_max + c.swap_fee_min) / 2);

        // positive target: swaps to -max_weight_deviation/2, should incur half of the max fee
        let post_swap_weight = target_weight - c.max_weight_deviation / 2;
        let fee = c
            .get_fee_to_charge(post_swap_weight, target_weight)
            .unwrap();
        assert_eq!(fee, (c.swap_fee_max + c.swap_fee_min) / 2);

        // negative target: swaps to +max_weight_deviation/2, should incur half of the max fee
        let post_swap_weight = -1 * target_weight + c.max_weight_deviation / 2;
        let fee = c
            .get_fee_to_charge(post_swap_weight, -1 * target_weight)
            .unwrap();
        assert_eq!(fee, (c.swap_fee_max + c.swap_fee_min) / 2);

        // negative target: swaps to -max_weight_deviation/2, should incur half of the max fee
        let post_swap_weight = -1 * target_weight - c.max_weight_deviation / 2;
        let fee = c
            .get_fee_to_charge(post_swap_weight, -1 * target_weight)
            .unwrap();
        assert_eq!(fee, (c.swap_fee_max + c.swap_fee_min) / 2);
    }

    #[test]
    fn test_get_weight() {
        let c = Constituent {
            swap_fee_min: -1 * PERCENTAGE_PRECISION_I64 / 10000, // -1 bps (rebate)
            swap_fee_max: PERCENTAGE_PRECISION_I64 / 100,        // 100 bps
            max_weight_deviation: PERCENTAGE_PRECISION_I64 / 10, // 10%
            spot_market_index: 0,
            spot_balance: BLPosition {
                scaled_balance: 500_000,
                cumulative_deposits: 1_000_000,
                balance_type: SpotBalanceType::Deposit,
                market_index: 0,
                ..BLPosition::default()
            },
            token_balance: 500_000,
            decimals: 6,
            ..Constituent::default()
        };

        let spot_market = SpotMarket {
            market_index: 0,
            decimals: 6,
            cumulative_deposit_interest: 10_000_000_000_000,
            ..SpotMarket::default()
        };

        let full_balance = c.get_full_balance(&spot_market).unwrap();
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

    fn get_mint_redeem_fee_scenario(now: i64, is_mint: bool, expected_fee: i64) {
        let lp_pool = LPPool {
            last_revenue_rebalance_ts: 0,
            revenue_rebalance_period: 3600, // hourly
            max_mint_fee_premium: 2000,     // 20 bps
            min_mint_fee: 100,              // 1 bps
            ..LPPool::default()
        };

        let fee = lp_pool.get_mint_redeem_fee(now, is_mint).unwrap();
        assert_eq!(fee, expected_fee);
    }

    #[test]
    fn test_get_mint_fee_before_dist() {
        get_mint_redeem_fee_scenario(0, true, 100);
    }

    #[test]
    fn test_get_mint_fee_during_dist() {
        get_mint_redeem_fee_scenario(1800, true, 1100);
    }

    #[test]
    fn test_get_mint_fee_after_dist() {
        get_mint_redeem_fee_scenario(3600, true, 2100);
    }

    #[test]
    fn test_get_redeem_fee_before_dist() {
        get_mint_redeem_fee_scenario(0, false, 2100);
    }

    #[test]
    fn test_get_redeem_fee_during_dist() {
        get_mint_redeem_fee_scenario(1800, false, 1100);
    }

    #[test]
    fn test_get_redeem_fee_after_dist() {
        get_mint_redeem_fee_scenario(3600, false, 100);
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
            last_revenue_rebalance_ts: 0,
            revenue_rebalance_period: 3600,
            max_mint_fee_premium: 0,
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
            spot_balance: BLPosition {
                scaled_balance: 0,
                cumulative_deposits: 0,
                balance_type: SpotBalanceType::Deposit,
                market_index: 0,
                ..BLPosition::default()
            },
            token_balance: token_balance as u64,
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
                now,
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
            last_revenue_rebalance_ts: 0,
            revenue_rebalance_period: 3600,
            max_mint_fee_premium: 2000, // 20 bps
            min_mint_fee: 100,          // 1 bps
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
            spot_balance: BLPosition {
                scaled_balance: 0,
                cumulative_deposits: 0,
                balance_type: SpotBalanceType::Deposit,
                market_index: 0,
                ..BLPosition::default()
            },
            token_balance: token_balance as u64,
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
                now,
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
            997900,         // expected_out_amount
            2100,           // expected_lp_fee
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
            9979000000,     // expected_out_amount
            210000,         // expected_lp_fee
            2993700,
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
            21,             // expected_lp_fee
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
            997900000000000,             // expected_out_amount
            21000000000000,              // expected_lp_fee
            473004600000,                // expected_out_fee_amount
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
            99790000000000000,           // expected_out_amount
            210000000000000,             // expected_lp_fee
            348167310000000,             // expected_out_fee_amount
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
            9_979_000_000_000_000_0000,   // expected_out_amount
            2100_000_000_000_000,         // expected_lp_fee
            3757093500000000000,          // expected_out_fee_amount
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
            BLPosition {
                scaled_balance: (in_token_amount.abs() as u128)
                    * (SPOT_BALANCE_PRECISION / 10_u128.pow(6)),
                balance_type: SpotBalanceType::Deposit,
                market_index: 0,
                ..BLPosition::default()
            }
        } else {
            BLPosition {
                scaled_balance: (in_token_amount.abs() as u128)
                    * (SPOT_BALANCE_PRECISION / 10_u128.pow(6)),
                balance_type: SpotBalanceType::Borrow,
                market_index: 0,
                ..BLPosition::default()
            }
        };

        let out_notional = (out_current_weight as i128) * lp_pool.last_aum.cast::<i128>().unwrap()
            / PERCENTAGE_PRECISION_I128;
        let out_token_amount = out_notional * 10_i128.pow(6) / oracle_1.price as i128;
        let out_spot_balance = if out_token_amount > 0 {
            BLPosition {
                scaled_balance: (out_token_amount.abs() as u128)
                    * (SPOT_BALANCE_PRECISION / 10_u128.pow(6)),
                balance_type: SpotBalanceType::Deposit,
                market_index: 0,
                ..BLPosition::default()
            }
        } else {
            BLPosition {
                scaled_balance: (out_token_amount.abs() as u128)
                    * (SPOT_BALANCE_PRECISION / 10_u128.pow(6)),
                balance_type: SpotBalanceType::Deposit,
                market_index: 0,
                ..BLPosition::default()
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

        let fee_execution_linear = lp_pool
            .get_linear_fee_execution(
                5_000_000 * QUOTE_PRECISION_I128,
                1600, // 0.0016
                2,
                15_000_000 * QUOTE_PRECISION,
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

        let fee_execution_quadratic = lp_pool
            .get_quadratic_fee_execution(
                5_000_000 * QUOTE_PRECISION_I128,
                1600, // 0.0016
                2,
                15_000_000 * QUOTE_PRECISION,
            )
            .unwrap();

        assert_eq!(fee_execution_quadratic, 711); // 7.1 bps
    }

    #[test]
    fn test_lp_pool_get_linear_fee_inventory() {
        let lp_pool = LPPool {
            last_aum: 10_000_000 * QUOTE_PRECISION, // $10,000,000
            ..LPPool::default()
        };

        let fee_inventory_linear = lp_pool
            .get_linear_fee_inventory(
                1_000_000 * QUOTE_PRECISION_I128,
                5_000_000 * QUOTE_PRECISION_I128,
                2, // this should be gamma, fixed precision?
            )
            .unwrap();

        assert_eq!(fee_inventory_linear, -2 * PERCENTAGE_PRECISION_I128 / 10000);
        // -2 bps
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
                5_000_000 * QUOTE_PRECISION_I128,
            )
            .unwrap();

        assert_eq!(fee_in, 6 * PERCENTAGE_PRECISION_I128 / 100000); // 0.6 bps
        assert_eq!(fee_out, -6 * PERCENTAGE_PRECISION_I128 / 100000); // -0.6 bps
    }
}
