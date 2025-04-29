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
