#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::lp_pool::*;
    use crate::state::oracle::OracleSource;
    use crate::state::spot_market::SpotBalanceType;
    use anchor_lang::prelude::Pubkey;

    const PERCENTAGE_PRECISION_I64: i64 = 1_000_000;

    fn weight_datum(constituent_index: u16, data: i64, last_slot: u64) -> WeightDatum {
        WeightDatum {
            constituent_index,
            padding: [0; 6],
            data,
            last_slot,
        }
    }
    fn amm_const_datum(
        perp_market_index: u16,
        constituent_index: u16,
        data: i64,
        last_slot: u64,
    ) -> AmmConstituentDatum {
        AmmConstituentDatum {
            perp_market_index,
            constituent_index,
            padding: [0; 4],
            data,
            last_slot,
        }
    }

    fn dummy_constituent(index: u16) -> Constituent {
        Constituent {
            pubkey: Pubkey::default(),
            constituent_index: index,
            max_weight_deviation: 0,
            swap_fee_min: 0,
            max_fee_premium: 0,
            spot_market_index: index,
            spot_balance: BLPosition {
                scaled_balance: 0,
                cumulative_deposits: 0,
                market_index: index,
                balance_type: SpotBalanceType::Deposit,
                padding: [0; 4],
            },
            padding: [0; 16],
        }
    }

    #[test]
    fn test_single_zero_weight() {
        let mapping = AmmConstituentMapping {
            data: vec![amm_const_datum(0, 1, 0, 0)],
        };

        let amm_inventory: Vec<(u16, i64)> = vec![(0, 1_000_000)];
        let prices = vec![1_000_000];
        let constituents = vec![dummy_constituent(0)];
        let aum = 1_000_000;
        let now_ts = 1000;

        let mut target = ConstituentTargetWeights::default();
        target
            .update_target_weights(
                &mapping,
                &amm_inventory,
                &constituents,
                &prices,
                aum,
                now_ts,
            )
            .unwrap();

        assert_eq!(target.data.len(), 1);
        assert_eq!(target.data[0].data, 0);
        assert_eq!(target.data[0].last_slot, now_ts);
    }

    #[test]
    fn test_single_full_weight() {
        let mapping = AmmConstituentMapping {
            data: vec![amm_const_datum(0, 1, PERCENTAGE_PRECISION_I64, 0)],
        };

        let amm_inventory = vec![(0, 1_000_000)];
        let prices = vec![1_000_000];
        let constituents = vec![dummy_constituent(0)];
        let aum = 1_000_000;
        let now_ts = 1234;

        let mut target = ConstituentTargetWeights::default();
        target
            .update_target_weights(
                &mapping,
                &amm_inventory,
                &constituents,
                &prices,
                aum,
                now_ts,
            )
            .unwrap();

        assert_eq!(target.data.len(), 1);
        assert_eq!(target.data[0].data, PERCENTAGE_PRECISION_I64);
        assert_eq!(target.data[0].last_slot, now_ts);
    }

    #[test]
    fn test_multiple_constituents_partial_weights() {
        let mapping = AmmConstituentMapping {
            data: vec![
                amm_const_datum(0, 1, PERCENTAGE_PRECISION_I64 / 2, 0),
                amm_const_datum(0, 2, PERCENTAGE_PRECISION_I64 / 2, 0),
            ],
        };

        let amm_inventory = vec![(0, 1_000_000)];
        let prices = vec![1_000_000, 1_000_000];
        let constituents = vec![dummy_constituent(0), dummy_constituent(1)];
        let aum = 1_000_000;
        let now_ts = 999;

        let mut target = ConstituentTargetWeights::default();
        target
            .update_target_weights(
                &mapping,
                &amm_inventory,
                &constituents,
                &prices,
                aum,
                now_ts,
            )
            .unwrap();

        assert_eq!(target.data.len(), 2);

        for datum in &target.data {
            assert_eq!(datum.data, PERCENTAGE_PRECISION_I64 / 2);
            assert_eq!(datum.last_slot, now_ts);
        }
    }

    #[test]
    fn test_zero_aum_safe() {
        let mapping = AmmConstituentMapping {
            data: vec![amm_const_datum(0, 1, PERCENTAGE_PRECISION_I64, 0)],
        };

        let amm_inventory = vec![(0, 1_000_000)];
        let prices = vec![1_000_000];
        let constituents = vec![dummy_constituent(0)];
        let aum = 0;
        let now_ts = 111;

        let mut target = ConstituentTargetWeights::default();
        target
            .update_target_weights(
                &mapping,
                &amm_inventory,
                &constituents,
                &prices,
                aum,
                now_ts,
            )
            .unwrap();

        assert_eq!(target.data.len(), 1);
        assert_eq!(target.data[0].data, PERCENTAGE_PRECISION_I64); // todo how to handle?
        assert_eq!(target.data[0].last_slot, now_ts);
    }

    #[test]
    fn test_overflow_protection() {
        let mapping = AmmConstituentMapping {
            data: vec![amm_const_datum(0, 1, i64::MAX, 0)],
        };

        let amm_inventory = vec![(0, i64::MAX)];
        let prices = vec![u64::MAX];
        let constituents = vec![dummy_constituent(0)];
        let aum = 1;
        let now_ts = 222;

        let mut target = ConstituentTargetWeights::default();
        target
            .update_target_weights(
                &mapping,
                &amm_inventory,
                &constituents,
                &prices,
                aum,
                now_ts,
            )
            .unwrap();

        assert_eq!(target.data.len(), 1);
        assert!(target.data[0].data <= PERCENTAGE_PRECISION_I64);
        assert_eq!(target.data[0].last_slot, now_ts);
    }
}
