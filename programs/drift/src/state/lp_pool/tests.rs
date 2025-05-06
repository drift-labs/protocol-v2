#[cfg(test)]
mod tests {
    use crate::math::constants::PERCENTAGE_PRECISION_I64;
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

        let amm_inventory: Vec<(u16, i64)> = vec![(0, 1_000_000)];
        let prices = vec![1_000_000];
        let constituent_indexes = vec![1];
        let aum = 1_000_000;
        let now_ts = 1000;

        let target_fixed = RefCell::new(ConstituentTargetWeightsFixed {
            len: 1,
            ..ConstituentTargetWeightsFixed::default()
        });
        let target_data = RefCell::new([0u8; 16]);
        let mut target_zc_mut =
            AccountZeroCopyMut::<'_, WeightDatum, ConstituentTargetWeightsFixed> {
                fixed: target_fixed.borrow_mut(),
                data: target_data.borrow_mut(),
                _marker: PhantomData::<WeightDatum>,
            };

        let totalw = target_zc_mut
            .update_target_weights(
                &mapping_zc,
                &amm_inventory,
                &constituent_indexes,
                &prices,
                aum,
                now_ts,
                WeightValidationFlags::NONE,
            )
            .unwrap();

        assert_eq!(totalw, 0);
        assert_eq!(target_zc_mut.len(), 1);
        assert_eq!(target_zc_mut.get(0).weight, 0);
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

        let amm_inventory = vec![(0, 1_000_000)];
        let prices = vec![1_000_000];
        let constituent_indexes = [1u16];
        let aum = 1_000_000;
        let now_ts = 1234;

        let target_fixed = RefCell::new(ConstituentTargetWeightsFixed {
            len: 1,
            ..ConstituentTargetWeightsFixed::default()
        });
        let target_data = RefCell::new([0u8; 16]);
        let mut target_zc_mut =
            AccountZeroCopyMut::<'_, WeightDatum, ConstituentTargetWeightsFixed> {
                fixed: target_fixed.borrow_mut(),
                data: target_data.borrow_mut(),
                _marker: PhantomData::<WeightDatum>,
            };

        let totalw = target_zc_mut
            .update_target_weights(
                &mapping_zc,
                &amm_inventory,
                &constituent_indexes,
                &prices,
                aum,
                now_ts,
                WeightValidationFlags::NONE,
            )
            .unwrap();

        assert_eq!(totalw, 1000000);

        assert_eq!(target_zc_mut.len(), 1);
        assert_eq!(target_zc_mut.get(0).weight, PERCENTAGE_PRECISION_I64);
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

        let amm_inventory = vec![(0, 1_000_000)];
        let prices = vec![1_000_000, 1_000_000];
        let constituent_indexes = vec![1, 2];
        let aum = 1_000_000;
        let now_ts = 999;

        let target_fixed = RefCell::new(ConstituentTargetWeightsFixed {
            len: amm_mapping_data.len() as u32,
            ..ConstituentTargetWeightsFixed::default()
        });
        let target_data = RefCell::new([0u8; 32]);
        let mut target_zc_mut =
            AccountZeroCopyMut::<'_, WeightDatum, ConstituentTargetWeightsFixed> {
                fixed: target_fixed.borrow_mut(),
                data: target_data.borrow_mut(),
                _marker: PhantomData::<WeightDatum>,
            };

        target_zc_mut
            .update_target_weights(
                &mapping_zc,
                &amm_inventory,
                &constituent_indexes,
                &prices,
                aum,
                now_ts,
                WeightValidationFlags::NONE,
            )
            .unwrap();

        assert_eq!(target_zc_mut.len(), 2);

        for i in 0..target_zc_mut.len() {
            assert_eq!(target_zc_mut.get(i).weight, PERCENTAGE_PRECISION_I64 / 2);
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

        let amm_inventory = vec![(0, 1_000_000)];
        let prices = vec![142_000_000];
        let constituent_indexes = vec![1u16];
        let aum = 0;
        let now_ts = 111;

        let target_fixed = RefCell::new(ConstituentTargetWeightsFixed {
            len: 1,
            ..ConstituentTargetWeightsFixed::default()
        });
        let target_data = RefCell::new([0u8; 16]);
        let mut target_zc_mut =
            AccountZeroCopyMut::<'_, WeightDatum, ConstituentTargetWeightsFixed> {
                fixed: target_fixed.borrow_mut(),
                data: target_data.borrow_mut(),
                _marker: PhantomData::<WeightDatum>,
            };

        target_zc_mut
            .update_target_weights(
                &mapping_zc,
                &amm_inventory,
                &constituent_indexes,
                &prices,
                aum,
                now_ts,
                WeightValidationFlags::NONE,
            )
            .unwrap();

        assert_eq!(target_zc_mut.len(), 1);
        assert_eq!(target_zc_mut.get(0).weight, 0); // no target
        assert_eq!(target_zc_mut.get(0).last_slot, now_ts);
    }

    #[test]
    fn test_overflow_protection() {
        let amm_datum = amm_const_datum(0, 1, i64::MAX, 0);
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

        let amm_inventory = vec![(0, i64::MAX)];
        let prices = vec![i64::MAX];
        let constituent_indexes = vec![1u16];
        let aum = 1;
        let now_ts = 222;

        let target_fixed = RefCell::new(ConstituentTargetWeightsFixed {
            len: 1,
            ..ConstituentTargetWeightsFixed::default()
        });
        let target_data = RefCell::new([0u8; 16]);
        let mut target_zc_mut =
            AccountZeroCopyMut::<'_, WeightDatum, ConstituentTargetWeightsFixed> {
                fixed: target_fixed.borrow_mut(),
                data: target_data.borrow_mut(),
                _marker: PhantomData::<WeightDatum>,
            };

        target_zc_mut
            .update_target_weights(
                &mapping_zc,
                &amm_inventory,
                &constituent_indexes,
                &prices,
                aum,
                now_ts,
                WeightValidationFlags::NONE,
            )
            .unwrap();

        assert_eq!(target_zc_mut.len(), 1);
        assert!(target_zc_mut.get(0).weight <= PERCENTAGE_PRECISION_I64);
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
    use crate::math::constants::PERCENTAGE_PRECISION_I64;
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
        in_decimals: u32,
        out_decimals: u32,
        in_amount: u64,
        expected_in_amount: u64,
        expected_out_amount: u64,
        expected_in_fee: i64,
        expected_out_fee: i64,
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

        let constituent_0 = Constituent {
            decimals: in_decimals as u8,
            swap_fee_min: PERCENTAGE_PRECISION_I64 / 10000,
            swap_fee_max: PERCENTAGE_PRECISION_I64 / 1000,
            // max_weight_deviation: PERCENTAGE_PRECISION_I64 / 10,
            ..Constituent::default()
        };
        let constituent_1 = Constituent {
            decimals: out_decimals as u8,
            swap_fee_min: PERCENTAGE_PRECISION_I64 / 10000,
            swap_fee_max: PERCENTAGE_PRECISION_I64 / 1000,
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
                in_amount,
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
            6,
            6,
            233_400_000,
            233_400_000,
            999900,
            23340, // 1 bps
            99,
        );
    }

    #[test]
    fn test_get_swap_amount_in_6_out_9() {
        get_swap_amount_decimals_scenario(6, 9, 233_400_000, 233_400_000, 999900000, 23340, 99990);
    }

    #[test]
    fn test_get_swap_amount_in_9_out_6() {
        get_swap_amount_decimals_scenario(
            9,
            6,
            233_400_000_000,
            233_400_000_000,
            999900,
            23340000,
            99,
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
        in_amount: u64,
        dlp_total_supply: u64,
        expected_lp_amount: u64,
        expected_lp_fee: i64,
        expected_in_fee_amount: i64,
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
            1_000_000,      // expected_lp_amount
            0,              // expected_lp_fee
            0,              // expected_in_fee_amount
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
            1_000_000,      // expected_lp_amount
            0,              // expected_lp_fee
            0,              // expected_in_fee_amount
        );
    }

    // test with 4 decimal constituent
    #[test]
    fn test_get_add_liquidity_mint_amount_with_zero_aum_4_decimals() {
        get_add_liquidity_mint_amount_scenario(
            0,         // last_aum
            0,         // now
            4,         // in_decimals
            10_000,    // in_amount (1 token) = $1
            0,         // dlp_total_supply
            1_000_000, // expected_lp_amount
            0,         // expected_lp_fee
            0,         // expected_in_fee_amount
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
            1_000_000,      // expected_lp_amount
            0,              // expected_lp_fee
            0,              // expected_in_fee_amount
        );
    }
}
