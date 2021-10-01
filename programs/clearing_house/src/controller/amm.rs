use crate::math::{
    amm, bn,
    constants::{MARK_PRICE_MANTISSA, PRICE_TO_PEG_PRECISION_RATIO},
};
use crate::state::market::AMM;

#[derive(Clone, Copy)]
pub enum SwapDirection {
    Add,
    Remove,
}

pub fn swap_quote_asset(
    amm: &mut AMM,
    quote_asset_swap_amount: u128,
    direction: SwapDirection,
    now: i64,
) -> (i128, bool) {
    amm.last_mark_price_twap = amm::calculate_new_mark_twap(amm, now);
    amm.last_mark_price_twap_ts = now;

    let unpegged_quote_asset_amount = quote_asset_swap_amount
        .checked_mul(MARK_PRICE_MANTISSA)
        .unwrap()
        .checked_div(amm.peg_multiplier)
        .unwrap();

    // min tick size a funciton of the peg.
    // 1000000 (expo 6) units of USDC = $1
    // ex: peg=40000 => min tick size of $1 / (1000000/40000) = $.04
    // my understanding is orders will be shrunk to the lowest tick size
    assert_ne!(unpegged_quote_asset_amount, 0);

    let initial_base_asset_amount = amm.base_asset_reserve;
    let (new_base_asset_amount, new_quote_asset_amount) = amm::calculate_swap_output(
        unpegged_quote_asset_amount,
        amm.quote_asset_reserve,
        direction,
        amm.sqrt_k,
    )
    .unwrap();
    let base_asset_price_before = amm.base_asset_price_with_mantissa();

    amm.base_asset_reserve = new_base_asset_amount;
    amm.quote_asset_reserve = new_quote_asset_amount;

    let acquired_base_asset_amount = (initial_base_asset_amount as i128)
        .checked_sub(new_base_asset_amount as i128)
        .unwrap();
    let base_asset_price_after = amm.base_asset_price_with_mantissa();

    let entry_price = amm::calculate_base_asset_price_with_mantissa(
        unpegged_quote_asset_amount,
        acquired_base_asset_amount.unsigned_abs(),
        amm.peg_multiplier,
    );

    let trade_size_too_small = match direction {
        SwapDirection::Add => {
            entry_price > base_asset_price_after || entry_price < base_asset_price_before
        }
        SwapDirection::Remove => {
            entry_price < base_asset_price_after || entry_price > base_asset_price_before
        }
    };

    return (acquired_base_asset_amount, trade_size_too_small);
}

pub fn swap_base_asset(
    amm: &mut AMM,
    base_asset_swap_amount: u128,
    direction: SwapDirection,
    now: i64,
) {
    amm.last_mark_price_twap = amm::calculate_new_mark_twap(amm, now);
    amm.last_mark_price_twap_ts = now;

    let (new_quote_asset_amount, new_base_asset_amount) = amm::calculate_swap_output(
        base_asset_swap_amount,
        amm.base_asset_reserve,
        direction,
        amm.sqrt_k,
    )
    .unwrap();

    amm.base_asset_reserve = new_base_asset_amount;
    amm.quote_asset_reserve = new_quote_asset_amount;
}

pub fn move_price(amm: &mut AMM, base_asset_amount: u128, quote_asset_amount: u128) {
    amm.base_asset_reserve = base_asset_amount;
    amm.quote_asset_reserve = quote_asset_amount;

    let k = bn::U256::from(base_asset_amount)
        .checked_mul(bn::U256::from(quote_asset_amount))
        .unwrap();

    amm.sqrt_k = k.integer_sqrt().try_to_u128().unwrap();
}

pub fn move_to_price(amm: &mut AMM, target_price: u128) {
    let sqrt_k = bn::U256::from(amm.sqrt_k);
    let k = sqrt_k.checked_mul(sqrt_k).unwrap();

    let new_base_asset_amount_squared = k
        .checked_mul(bn::U256::from(amm.peg_multiplier))
        .unwrap()
        .checked_mul(bn::U256::from(PRICE_TO_PEG_PRECISION_RATIO))
        .unwrap()
        .checked_div(bn::U256::from(target_price))
        .unwrap();

    let new_base_asset_amount = new_base_asset_amount_squared.integer_sqrt();
    let new_quote_asset_amount = k.checked_div(new_base_asset_amount).unwrap();

    amm.base_asset_reserve = new_base_asset_amount.try_to_u128().unwrap();
    amm.quote_asset_reserve = new_quote_asset_amount.try_to_u128().unwrap();
}
