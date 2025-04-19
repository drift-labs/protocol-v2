#[cfg(test)]
mod tests {
    use super::*;
    use crate::create_account_info;
    use crate::state::lp_pool::*;
    use crate::state::oracle::OracleSource;
    use crate::state::spot_market::SpotBalanceType;
    use crate::test_utils::*;
    use anchor_lang::prelude::Pubkey;

    const PERCENTAGE_PRECISION_U64: u64 = 1_000_000;

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

    fn dummy_constituent(index: u16, decimals: u8) -> Constituent {
        Constituent {
            pubkey: Pubkey::default(),
            constituent_index: index,
            oracle: Pubkey::default(),
            oracle_source: OracleSource::default(),
            decimals,
            max_weight_deviation: PERCENTAGE_PRECISION_U64.safe_div(10).unwrap(), // 10% deviation allowed
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

    fn dummy_lp_pool() -> LPPool {
        LPPool {
            name: [0; 32],
            pubkey: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            max_aum: 100_000_000_000_000,
            last_aum: 1_000_000_000_000,
            last_aum_slot: 0,
            last_revenue_rebalance_ts: 0,
            total_fees_received: 0,
            total_fees_paid: 0,
            constituents: 0,
            padding: [0; 6],
        }
    }

    fn dummy_target_weights(weights: Vec<(u16, i64)>) -> ConstituentTargetWeights {
        ConstituentTargetWeights {
            num_rows: weights.len() as u16,
            data: weights
                .into_iter()
                .enumerate()
                .map(|(_i, w)| weight_datum(w.0, w.1, 0))
                .collect(),
        }
    }

    #[test]
    fn test_single_zero_weight() {
        let mapping = AmmConstituentMapping {
            data: vec![amm_const_datum(0, 1, 0, 0)],
        };

        let amm_inventory: Vec<(u16, u64)> = vec![(0, 1_000_000)];
        let prices = vec![1_000_000];
        let constituents = vec![dummy_constituent(0, 6)];
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
        let constituents = vec![dummy_constituent(0, 6)];
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
        let constituents = vec![dummy_constituent(0, 6), dummy_constituent(1, 6)];
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
        let constituents = vec![dummy_constituent(0, 6)];
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

        let amm_inventory = vec![(0, u64::MAX)];
        let prices = vec![u64::MAX];
        let constituents = vec![dummy_constituent(0, 6)];
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

    #[test]
    fn test_get_weight() {
        let price = 1_000_000;
        let lp_pool_aum = 1_000_000_000_000;

        // 10 bps of aum, 6 decimals token
        let constituent = dummy_constituent(0, 6);
        let token_amount = 1_000_000_000;
        let weight = constituent
            .get_weight(price, token_amount, 0, lp_pool_aum)
            .unwrap();
        assert_eq!(weight, 1000);

        // 10 bps of aum, 4 decimals token
        let constituent = dummy_constituent(0, 4);
        let token_amount = 10_000_000;
        let weight = constituent
            .get_weight(price, token_amount, 0, lp_pool_aum)
            .unwrap();
        assert_eq!(weight, 1000);

        // 10 bps of aum, 9 decimals token
        let constituent = dummy_constituent(0, 8);
        let token_amount = 100_000_000_000;
        let weight = constituent
            .get_weight(price, token_amount, 0, lp_pool_aum)
            .unwrap();
        assert_eq!(weight, 1000);
    }

    #[test]
    fn test_get_swap_fees() {
        let oracle_program = crate::ids::pyth_program::id();
        let sol_oracle_key = Pubkey::new_unique();
        create_account_info!(
            get_pyth_price(200, 6),
            &sol_oracle_key,
            &oracle_program,
            sol_oracle_account_info
        );
        let btc_oracle_key = Pubkey::new_unique();
        create_account_info!(
            get_pyth_price(100_000, 6),
            &btc_oracle_key,
            &oracle_program,
            btc_oracle_account_info
        );

        let mut oracle_map = OracleMap::load(
            &mut vec![sol_oracle_account_info, btc_oracle_account_info]
                .iter()
                .peekable(),
            0,
            None,
        )
        .expect("failed to load oracle map");

        let target_weights = dummy_target_weights(vec![
            (0, PERCENTAGE_PRECISION_I64.safe_div(2).unwrap()), // target 50%
            (1, PERCENTAGE_PRECISION_I64.safe_div(2).unwrap()), // target 50%
        ]);

        let mut in_constituent = dummy_constituent(0, 9);
        in_constituent.swap_fee_min = 100; // 0.01% min fee
        in_constituent.max_fee_premium = 5000; // 0.5% max premium
        in_constituent.oracle = sol_oracle_key;
        in_constituent.oracle_source = OracleSource::Pyth;

        let mut out_constituent = dummy_constituent(1, 8);
        out_constituent.swap_fee_min = 100; // 0.01% min fee
        out_constituent.max_fee_premium = 5000; // 0.5% max premium
        out_constituent.oracle = btc_oracle_key;
        out_constituent.oracle_source = OracleSource::Pyth;

        let in_token_balance = 1_000_000_000; // 1 SOL
        let out_token_balance = 1_000_000_000; // 10 BTC

        let mut lp_pool = dummy_lp_pool();
        lp_pool.last_aum = 1_000_000_000_000;

        let in_amount = 1_000_000_000; // 1 SOL
        let out_amount = 200_000; // 0.2 BTC

        let (in_fee, out_fee) = lp_pool
            .get_swap_fees(
                &mut oracle_map,
                &target_weights,
                in_constituent,
                in_token_balance,
                out_constituent,
                out_token_balance,
                in_amount,
                out_amount,
            )
            .expect("failed to get swap fees");
        assert_eq!(in_fee, 5000); // 0.5% fee on input (max fee premium)
        assert_eq!(out_fee, 5000); // 0.5% fee on output (max fee premium)
    }
}
