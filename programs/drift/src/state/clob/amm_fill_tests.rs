use crate::controller::amm::{calculate_base_swap_output_with_spread, SwapDirection};
use crate::controller::position::PositionDirection;
use crate::math::amm::calculate_amm_available_liquidity;
use crate::math::orders::{
    calculate_base_asset_amount_for_amm_to_fulfill, standardize_base_asset_amount,
};
use crate::state::oracle::HistoricalOracleData;
use crate::state::perp_market::{AMM, PerpMarket};
use crate::state::state::FeeTier;
use crate::state::user::{MarketType, Order, OrderStatus, OrderType};

fn snapshot_market() -> PerpMarket {
    // Construct a PerpMarket using the provided snapshot values (only fields relevant for tests)
    let amm = AMM {
        // Reserves and curve
        base_asset_reserve: 24_356_161_923_661_673u128,
        quote_asset_reserve: 24_344_077_619_629_872u128,
        concentration_coef: 1_004_142u128,
        min_base_asset_reserve: 24_248_871_119_484_767u128,
        max_base_asset_reserve: 24_450_164_785_448_319u128,
        sqrt_k: 24_350_119_022_006_718u128,
        peg_multiplier: 165_719_072u128,
        terminal_quote_asset_reserve: 24_350_928_127_235_800u128,

        // Open interest and position aggregates
        base_asset_amount_long: 1_014_421_740_000_000i128,
        base_asset_amount_short: -1_021_273_720_000_000i128,
        base_asset_amount_with_amm: -6_851_980_000_000i128,
        base_asset_amount_with_unsettled_lp: 0i128,
        max_open_interest: 2_000_000_000_000_000u128,
        quote_asset_amount: 16_193_235_523_903i128,

        // Spread reserves (not directly used in the market-order tests, but kept for completeness)
        ask_base_asset_reserve: 24_364_250_984_413_470u128,
        ask_quote_asset_reserve: 24_335_995_256_542_346u128,
        bid_base_asset_reserve: 24_377_889_097_545_403u128,
        bid_quote_asset_reserve: 24_322_380_580_753_197u128,

        // Oracle + marks (subset)
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price: 165_636_851,
            last_oracle_conf: 0,
            last_oracle_delay: 1,
            last_oracle_price_twap: 165_731_672,
            last_oracle_price_twap_5min: 165_753_338,
            last_oracle_price_twap_ts: 1_762_208_768,
        },
        last_oracle_normalised_price: 165_636_851,
        last_oracle_conf_pct: 143,
        last_bid_price_twap: 165_539_630,
        last_ask_price_twap: 165_600_506,
        last_mark_price_twap: 165_570_068,
        last_mark_price_twap_5min: 165_579_212,
        last_update_slot: 377_740_307,

        // Order sizing / tick config
        order_step_size: 10_000_000u64,
        order_tick_size: 100u64,
        min_order_size: 10_000_000u64,

        // Limits
        max_fill_reserve_fraction: 25_000u16,
        max_slippage_ratio: 50u16,

        // Spread configuration
        base_spread: 200u32,
        max_spread: 20_000u32,
        long_spread: 264u32,
        short_spread: 855u32,

        // Activity / stats (subset)
        volume_24h: 165_848_742_627_226u64,
        long_intensity_volume: 3_467_697_441_252u64,
        short_intensity_volume: 4_203_699_153_577u64,
        last_trade_ts: 1_762_208_752,
        mark_std: 153_189u64,
        oracle_std: 123_049u64,

        // Other fields defaulted
        ..AMM::default()
    };

    PerpMarket {
        amm,
        // fee_adjustment = 0 keeps limit-price buffer neutral for tests
        fee_adjustment: 0,
        market_index: 0,
        status: Default::default(),
        contract_type: Default::default(),
        contract_tier: Default::default(),
        ..PerpMarket::default()
    }
}

fn simple_order(direction: PositionDirection, base: u64) -> Order {
    Order {
        status: OrderStatus::Open,
        order_type: OrderType::Market,
        market_type: MarketType::Perp,
        direction,
        base_asset_amount: base,
        base_asset_amount_filled: 0,
        price: 0, // market order
        market_index: 0,
        ..Order::default()
    }
}

#[test]
fn amm_bbo() {
    let market = snapshot_market();
    let reserve_price = market.amm.reserve_price().expect("reserve_price failed");
    assert_eq!(reserve_price, 165_636_850); //  165.636850
    // last oracle price = 165.636851
    // skew 6e-9

    // spread = 11.1933 bps
    let (bid_price, ask_price) = market.amm.bid_ask_price(reserve_price).expect("bid_ask_price failed");
    assert_eq!(bid_price, 165_495_230); // 165.495230
    assert_eq!(ask_price, 165_680_578); // 165.680578
}

#[test]
fn amm_fill_caps_to_available_liquidity_long() {
    let market = snapshot_market();

    // Compute expected available liquidity for a single Long (buy) fill
    let expected_cap = calculate_amm_available_liquidity(&market.amm, &PositionDirection::Long)
        .expect("calculate_amm_available_liquidity failed");

    // Make order larger than available liquidity so function should cap to expected_cap
    let order = simple_order(PositionDirection::Long, expected_cap.saturating_mul(2));

    let fee_tier = FeeTier::default();
    let (filled_base, returned_limit) = calculate_base_asset_amount_for_amm_to_fulfill(
        &order,
        &market,
        /*limit_price=*/ None,
        /*override_fill_price=*/ None,
        /*existing_base_asset_amount=*/ 0,
        &fee_tier,
    )
    .expect("calculate_base_asset_amount_for_amm_to_fulfill failed");

    assert_eq!(returned_limit, None);
    assert_eq!(filled_base, expected_cap);
    assert_eq!(filled_base, 974_240_000_000);

    let (_, _, quote_asset_amount, quote_asset_amount_surplus) = calculate_base_swap_output_with_spread(
        &market.amm,
        filled_base,
        SwapDirection::Remove,
    ).expect("calculate_base_swap_output_with_spread failed");

    assert_eq!(quote_asset_amount, 161_269_360_205); // 161_269.360_205
    assert_eq!(quote_asset_amount_surplus, 107_140_064); // 107.140_064

    // fill price =  161_269_360_205 / 974_240_000_000 * 1000 = 165.5335032487
    // slippage = fill/ask - 1 = 165.5335032487 / 165.680578 - 1
}

#[test]
fn amm_fill_within_liquidity_short_uses_unfilled_amount() {
    let market = snapshot_market();

    // Small order that is well within liquidity; it should return standardized unfilled
    let desired = 100_000_000u64; // multiple of step size (10_000_000)
    let order = simple_order(PositionDirection::Short, desired);

    let fee_tier = FeeTier::default();
    let (filled_base, returned_limit) = calculate_base_asset_amount_for_amm_to_fulfill(
        &order,
        &market,
        /*limit_price=*/ None,
        /*override_fill_price=*/ None,
        /*existing_base_asset_amount=*/ 0,
        &fee_tier,
    )
    .expect("calculate_base_asset_amount_for_amm_to_fulfill failed");

    // Ensure we didn't exceed AMM side cap
    let cap = calculate_amm_available_liquidity(&market.amm, &PositionDirection::Short)
        .expect("calculate_amm_available_liquidity failed");
    assert!(filled_base <= cap);

    // And the result equals standardized desired size
    let standardized = standardize_base_asset_amount(desired, market.amm.order_step_size)
        .expect("standardize_base_asset_amount failed");
    assert_eq!(returned_limit, None);
    assert_eq!(filled_base, standardized);
}

#[test]
fn amm_fill_trigger_order_not_triggered_returns_zero() {
    let market = snapshot_market();
    let mut order = simple_order(PositionDirection::Long, 1_000_000_000);
    // Convert to trigger order that is not yet triggered
    order.order_type = OrderType::TriggerLimit;
    order.trigger_price = 999_999_999; // arbitrary
    // Default trigger_condition is Above; keep it untriggered

    let fee_tier = FeeTier::default();
    let (filled_base, _returned_limit) = calculate_base_asset_amount_for_amm_to_fulfill(
        &order,
        &market,
        /*limit_price=*/ None,
        /*override_fill_price=*/ None,
        /*existing_base_asset_amount=*/ 0,
        &fee_tier,
    )
    .expect("calculate_base_asset_amount_for_amm_to_fulfill failed");

    assert_eq!(filled_base, 0);
}


