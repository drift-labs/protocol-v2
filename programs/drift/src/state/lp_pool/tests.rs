use super::*;
use crate::math::constants::PERCENTAGE_PRECISION_U64;
use crate::state::oracle::OracleSource;

fn weight_datum(data: u64, last_slot: u64) -> WeightDatum {
    WeightDatum { data, last_slot }
}

fn dummy_constituent(index: u16) -> Constituent {
    Constituent {
        pubkey: Pubkey::default(),
        constituent_index: index,
        oracle: Pubkey::default(),
        oracle_source: OracleSource::Pyth,
        max_weight_deviation: 0,
        swap_fee_min: 0,
        max_fee_premium: 0,
        spot_market_index: index,
        last_oracle_price: 0,
        last_oracle_price_ts: 0,
        spot_balance: BLPosition {
            scaled_balance: 0,
            cumulative_deposits: 0,
            market_index: index,
            balance_type: SpotBalanceType::Deposit,
            padding: [0; 4],
        },
    }
}

#[test]
fn test_single_zero_weight() {
    let mut mapping = AmmConstituentMapping {
        num_rows: 1,
        num_cols: 1,
        data: vec![weight_datum(0, 0)],
    };

    let amm_inventory = vec![1_000_000u64]; // 1 unit
    let prices = vec![1_000_000u64]; // price = 1.0
    let constituents = vec![dummy_constituent(0)];
    let aum = 1_000_000; // 1 USD
    let now_ts = 1000;

    let mut target = ConstituentTargetWeights {
        num_rows: 0,
        num_cols: 0,
        oldest_weight_ts: 0,
        data: vec![],
    };

    target.update_target_weights(
        &mapping,
        &amm_inventory,
        &constituents,
        &prices,
        aum,
        now_ts,
    );

    assert_eq!(target.data.len(), 1);
    assert_eq!(target.data[0].data, 0);
    assert_eq!(target.data[0].last_slot, now_ts);
}

#[test]
fn test_single_full_weight() {
    let mut mapping = AmmConstituentMapping {
        num_rows: 1,
        num_cols: 1,
        data: vec![weight_datum(PERCENTAGE_PRECISION_U64, 0)],
    };

    let amm_inventory = vec![1_000_000];
    let prices = vec![1_000_000]; // price = 1.0
    let constituents = vec![dummy_constituent(0)];
    let aum = 1_000_000; // 1 USD
    let now_ts = 1234;

    let mut target = ConstituentTargetWeights::default();
    target.update_target_weights(
        &mapping,
        &amm_inventory,
        &constituents,
        &prices,
        aum,
        now_ts,
    );

    assert_eq!(target.data.len(), 1);
    assert_eq!(target.data[0].data, PERCENTAGE_PRECISION_U64); // 100%
    assert_eq!(target.data[0].last_slot, now_ts);
}

#[test]
fn test_multiple_constituents_partial_weights() {
    let mut mapping = AmmConstituentMapping {
        num_rows: 1,
        num_cols: 2,
        data: vec![
            weight_datum(PERCENTAGE_PRECISION_U64 / 2, 0),
            weight_datum(PERCENTAGE_PRECISION_U64 / 2, 0),
        ],
    };

    let amm_inventory = vec![1_000_000];
    let prices = vec![1_000_000, 1_000_000];
    let constituents = vec![dummy_constituent(0), dummy_constituent(1)];
    let aum = 1_000_000;
    let now_ts = 999;

    let mut target = ConstituentTargetWeights::default();
    target.update_target_weights(
        &mapping,
        &amm_inventory,
        &constituents,
        &prices,
        aum,
        now_ts,
    );

    assert_eq!(target.data.len(), 2);
    assert_eq!(target.data[0].data, PERCENTAGE_PRECISION_U64 / 2);
    assert_eq!(target.data[1].data, PERCENTAGE_PRECISION_U64 / 2);
}

#[test]
fn test_zero_aum_safe() {
    let mut mapping = AmmConstituentMapping {
        num_rows: 1,
        num_cols: 1,
        data: vec![weight_datum(PERCENTAGE_PRECISION_U64, 0)],
    };

    let amm_inventory = vec![1_000_000];
    let prices = vec![1_000_000];
    let constituents = vec![dummy_constituent(0)];
    let aum = 0;
    let now_ts = 111;

    let mut target = ConstituentTargetWeights::default();
    target.update_target_weights(
        &mapping,
        &amm_inventory,
        &constituents,
        &prices,
        aum,
        now_ts,
    );

    assert_eq!(target.data.len(), 2);
    assert_eq!(target.data[0].data, 0); // No division by zero panic
}

#[test]
fn test_overflow_protection() {
    let mut mapping = AmmConstituentMapping {
        num_rows: 1,
        num_cols: 1,
        data: vec![weight_datum(u64::MAX, 0)],
    };

    let amm_inventory = vec![u64::MAX];
    let prices = vec![u64::MAX];
    let constituents = vec![dummy_constituent(0)];
    let aum = 1; // smallest possible AUM to maximize weight
    let now_ts = 222;

    let mut target = ConstituentTargetWeights::default();
    target.update_target_weights(
        &mapping,
        &amm_inventory,
        &constituents,
        &prices,
        aum,
        now_ts,
    );

    assert_eq!(target.data.len(), 2);
    assert!(target.data[0].data <= PERCENTAGE_PRECISION_U64); // cap at max
}
