use crate::bn;
use crate::curve;
use crate::{SwapDirection, MARK_PRICE_MANTISSA, PRICE_TO_PEG_PRECISION_RATIO};
use anchor_lang::prelude::*;
use std::cmp::max;

#[account(zero_copy)]
pub struct Markets {
    pub markets: [Market; 1000],
}

impl Default for Markets {
    fn default() -> Self {
        return Markets {
            markets: [Market::default(); 1000],
        };
    }
}

impl Markets {
    pub fn index_from_u64(index: u64) -> usize {
        return std::convert::TryInto::try_into(index).unwrap();
    }
}

#[zero_copy]
#[derive(Default)]
pub struct Market {
    pub initialized: bool,
    pub base_asset_amount_long: i128,
    pub base_asset_amount_short: i128,
    pub base_asset_amount: i128, // net market bias
    pub open_interest: u128,     // number of users in a position
    // remove
    pub base_asset_volume: u128, // amt of base asset volume since inception
    pub amm: AMM,
}

#[derive(Clone, Copy)]
pub enum OracleSource {
    Pyth,
    Switchboard,
}

impl Default for OracleSource {
    // UpOnly
    fn default() -> Self {
        OracleSource::Pyth
    }
}

#[zero_copy]
#[derive(Default)]
pub struct AMM {
    pub oracle: Pubkey,
    pub oracle_source: OracleSource,
    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
    pub cumulative_funding_rate: i128,
    pub cumulative_repeg_rebate_long: u128,
    pub cumulative_repeg_rebate_short: u128,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub last_funding_rate: i128,
    pub last_funding_rate_ts: i64,
    // remove
    pub prev_funding_rate_ts: i64,
    pub funding_period: i64,
    pub last_mark_price_twap: u128,
    pub last_mark_price_twap_ts: i64,
    pub sqrt_k: u128,
    pub peg_multiplier: u128,
    pub cumulative_fee: u128,
    pub cumulative_fee_realized: u128,
}

impl AMM {
    pub fn swap_quote_asset_with_fee(
        &mut self,
        quote_asset_swap_amount: u128,
        direction: SwapDirection,
        now: i64,
    ) -> (i128, i128, bool) {
        let thousand: u128 = 1000;
        let one_hundreth: u128 = 100;

        // 1% * 50/1000 (5/100) = .05%
        let fixed_fee = 50; // 5 bps, .05% fee 50/1000
        let fee = quote_asset_swap_amount
            .checked_mul(fixed_fee)
            .unwrap()
            .checked_div(thousand)
            .unwrap()
            .checked_div(one_hundreth)
            .unwrap();

        let (acquired_base_asset_amount, trade_size_too_small) =
            self.swap_quote_asset(quote_asset_swap_amount, direction, now);

        self.cumulative_fee = self.cumulative_fee.checked_add(fee).unwrap();
        self.cumulative_fee_realized = self.cumulative_fee_realized.checked_add(fee).unwrap();

        return (
            acquired_base_asset_amount,
            fee as i128,
            trade_size_too_small,
        );
    }

    pub fn swap_quote_asset(
        &mut self,
        quote_asset_swap_amount: u128,
        direction: SwapDirection,
        now: i64,
    ) -> (i128, bool) {
        let unpegged_quote_asset_amount = quote_asset_swap_amount
            .checked_mul(MARK_PRICE_MANTISSA)
            .unwrap()
            .checked_div(self.peg_multiplier)
            .unwrap();

        // min tick size a funciton of the peg.
        // 1000000 (expo 6) units of USDC = $1
        // ex: peg=40000 => min tick size of $1 / (1000000/40000) = $.04
        // my understanding is orders will be shrunk to the lowest tick size
        assert_ne!(unpegged_quote_asset_amount, 0);

        let initial_base_asset_amount = self.base_asset_reserve;
        let (new_base_asset_amount, new_quote_asset_amount) = AMM::find_swap_output(
            unpegged_quote_asset_amount,
            self.quote_asset_reserve,
            direction,
            self.sqrt_k,
        )
        .unwrap();
        let base_asset_price_before = self.base_asset_price_with_mantissa();

        self.base_asset_reserve = new_base_asset_amount;
        self.quote_asset_reserve = new_quote_asset_amount;

        self.last_mark_price_twap = self.get_new_twap(now);
        self.last_mark_price_twap_ts = now;

        let acquired_base_asset_amount = (initial_base_asset_amount as i128)
            .checked_sub(new_base_asset_amount as i128)
            .unwrap();
        let base_asset_price_after = self.base_asset_price_with_mantissa();

        let entry_price = curve::calculate_base_asset_price_with_mantissa(
            unpegged_quote_asset_amount,
            acquired_base_asset_amount.unsigned_abs(),
            self.peg_multiplier,
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
        &mut self,
        base_asset_swap_amount: u128,
        direction: SwapDirection,
        now: i64,
    ) {
        let (new_quote_asset_amount, new_base_asset_amount) = AMM::find_swap_output(
            base_asset_swap_amount,
            self.base_asset_reserve,
            direction,
            self.sqrt_k,
        )
        .unwrap();

        self.base_asset_reserve = new_base_asset_amount;
        self.quote_asset_reserve = new_quote_asset_amount;

        self.last_mark_price_twap = self.get_new_twap(now);
        self.last_mark_price_twap_ts = now;
    }

    fn find_swap_output(
        swap_amount: u128,
        input_asset_amount: u128,
        direction: SwapDirection,
        invariant_sqrt: u128,
    ) -> Option<(u128, u128)> {
        let invariant_sqrt_u256 = bn::U256::from(invariant_sqrt);
        let invariant = invariant_sqrt_u256.checked_mul(invariant_sqrt_u256)?;

        let new_input_amount = if let SwapDirection::Add = direction {
            input_asset_amount.checked_add(swap_amount)?
        } else {
            input_asset_amount.checked_sub(swap_amount)?
        };

        let new_output_amount = invariant
            .checked_div(bn::U256::from(new_input_amount))?
            .try_to_u128()
            .unwrap();

        return Option::Some((new_output_amount, new_input_amount));
    }

    pub fn find_swap_output_and_pnl(
        self,
        base_swap_amount: u128,
        quote_asset_notional_amount: u128,
        direction: SwapDirection,
    ) -> (u128, i128) {
        let initial_quote_asset_amount = self.quote_asset_reserve;

        let (new_quote_asset_amount, _new_base_asset_amount) = AMM::find_swap_output(
            base_swap_amount,
            self.base_asset_reserve,
            direction,
            self.sqrt_k,
        )
        .unwrap();

        let mut quote_asset_acquired = match direction {
            SwapDirection::Add => initial_quote_asset_amount
                .checked_sub(new_quote_asset_amount)
                .unwrap(),

            SwapDirection::Remove => new_quote_asset_amount
                .checked_sub(initial_quote_asset_amount)
                .unwrap(),
        };

        quote_asset_acquired = quote_asset_acquired
            .checked_mul(self.peg_multiplier)
            .unwrap()
            .checked_div(MARK_PRICE_MANTISSA)
            .unwrap();

        let pnl = match direction {
            SwapDirection::Add => (quote_asset_acquired as i128)
                .checked_sub(quote_asset_notional_amount as i128)
                .unwrap(),

            SwapDirection::Remove => (quote_asset_notional_amount as i128)
                .checked_sub(quote_asset_acquired as i128)
                .unwrap(),
        };

        return (quote_asset_acquired, pnl);
    }

    pub fn base_asset_price_with_mantissa(&self) -> u128 {
        let ast_px = curve::calculate_base_asset_price_with_mantissa(
            self.quote_asset_reserve,
            self.base_asset_reserve,
            self.peg_multiplier,
        );

        return ast_px;
    }

    pub fn calculate_repeg_candidate_pnl(&self, new_peg_candidate: u128) -> i128 {
        let net_user_market_position = (self.sqrt_k as i128)
            .checked_sub(self.base_asset_reserve as i128)
            .unwrap();

        let peg_spread_1 = (new_peg_candidate as i128)
            .checked_sub(self.peg_multiplier as i128)
            .unwrap();

        let peg_spread_direction: i128 = if peg_spread_1 > 0 { 1 } else { -1 };
        let market_position_bias_direction: i128 =
            if net_user_market_position > 0 { 1 } else { -1 };
        msg!("ps: {:?}", peg_spread_1);
        let pnl = (bn::U256::from(
            peg_spread_1
                .unsigned_abs()
                .checked_mul(PRICE_TO_PEG_PRECISION_RATIO)
                .unwrap(),
        )
        .checked_mul(bn::U256::from(net_user_market_position))
        .unwrap()
        .checked_mul(bn::U256::from(self.base_asset_price_with_mantissa()))
        .unwrap()
        .checked_div(bn::U256::from(MARK_PRICE_MANTISSA))
        .unwrap()
        .checked_div(bn::U256::from(MARK_PRICE_MANTISSA))
        .unwrap()
        .checked_div(bn::U256::from(MARK_PRICE_MANTISSA))
        .unwrap()
        .try_to_u128()
        .unwrap() as i128)
            .checked_mul(
                market_position_bias_direction
                    .checked_mul(peg_spread_direction)
                    .unwrap(),
            )
            .unwrap();

        msg!("pnl: {:?}", pnl);
        return pnl;
    }

    pub fn get_pyth_price(&self, price_oracle: &AccountInfo, window: u32) -> (i128, u128) {
        let pyth_price_data = price_oracle.try_borrow_data().unwrap();
        let price_data = pyth_client::cast::<pyth_client::Price>(&pyth_price_data);

        // todo: support some interpolated number based on window_size
        // currently only support (0, 1hour+] (since funding_rate_ts)
        // window can check spread over a time window instead
        let oracle_price = if window > 0 {
            price_data.twap.val as i128
        } else {
            price_data.agg.price as i128
        };

        let oracle_conf = if window > 0 {
            price_data.twac.val as u128
        } else {
            price_data.agg.conf as u128
        };

        let oracle_mantissa = 10_u128.pow(price_data.expo.unsigned_abs());

        let mut oracle_scale_mult = 1;
        let mut oracle_scale_div = 1;

        if oracle_mantissa > MARK_PRICE_MANTISSA {
            oracle_scale_div = oracle_mantissa.checked_div(MARK_PRICE_MANTISSA).unwrap();
        } else {
            oracle_scale_mult = MARK_PRICE_MANTISSA.checked_div(oracle_mantissa).unwrap();
        }

        let oracle_price_scaled = (oracle_price)
            .checked_mul(oracle_scale_mult as i128)
            .unwrap()
            .checked_div(oracle_scale_div as i128)
            .unwrap();
        let oracle_conf_scaled = (oracle_conf)
            .checked_mul(oracle_scale_mult)
            .unwrap()
            .checked_div(oracle_scale_div)
            .unwrap();

        return (oracle_price_scaled, oracle_conf_scaled);
    }

    pub fn get_oracle_price(&self, price_oracle: &AccountInfo, window: u32) -> (i128, u128) {
        let (oracle_px, oracle_conf) = match self.oracle_source {
            OracleSource::Pyth => self.get_pyth_price(price_oracle, window),
            OracleSource::Switchboard => (0, 0),
        };

        return (oracle_px, oracle_conf);
    }

    pub fn get_new_twap(&self, now: i64) -> u128 {
        let since_last = max(1, now - self.last_mark_price_twap_ts);
        let since_start = max(1, self.last_mark_price_twap_ts - self.last_funding_rate_ts);
        let denom = (since_last + since_start) as u128;

        let prev_twap_99 = self
            .last_mark_price_twap
            .checked_mul(since_start as u128)
            .unwrap();
        let latest_price_01 = self
            .base_asset_price_with_mantissa()
            .checked_mul(since_last as u128)
            .unwrap();
        let new_twap = prev_twap_99
            .checked_add(latest_price_01 as u128)
            .unwrap()
            .checked_div(denom)
            .unwrap();
        return new_twap;
    }

    pub fn get_oracle_mark_spread(&self, price_oracle: &AccountInfo, window: u32) -> i128 {
        let mark_price: i128;

        // todo: support some interpolated number based on window_size
        // currently only support (0, 1hour+] (since funding_rate_ts)
        // window can check spread over a time window instead
        if window > 0 {
            mark_price = self.last_mark_price_twap as i128;
        } else {
            mark_price = self.base_asset_price_with_mantissa() as i128;
        }

        let (oracle_price, _oracle_conf) = self.get_oracle_price(price_oracle, window);

        let price_spread = mark_price.checked_sub(oracle_price).unwrap();

        return price_spread;
    }

    pub fn move_price(&mut self, base_asset_amount: u128, quote_asset_amount: u128) {
        self.base_asset_reserve = base_asset_amount;
        self.quote_asset_reserve = quote_asset_amount;

        let sqrtk1 = bn::U256::from(base_asset_amount);
        let sqrtk2 = bn::U256::from(quote_asset_amount);
        let k = sqrtk1.checked_mul(sqrtk2).unwrap();
        let sqrtk = k.integer_sqrt();
        self.sqrt_k = sqrtk.try_to_u128().unwrap();
    }

    pub fn move_to_price(&mut self, target_price: u128) {
        let sqrtk = bn::U256::from(self.sqrt_k);
        let k = sqrtk.checked_mul(sqrtk).unwrap();

        let new_base_asset_amount_squared = k
            .checked_mul(bn::U256::from(self.peg_multiplier))
            .unwrap()
            .checked_mul(bn::U256::from(PRICE_TO_PEG_PRECISION_RATIO))
            .unwrap()
            .checked_div(bn::U256::from(target_price))
            .unwrap();

        let new_base_asset_amount = new_base_asset_amount_squared.integer_sqrt();
        let new_quote_asset_amount = k.checked_div(new_base_asset_amount).unwrap();

        self.base_asset_reserve = new_base_asset_amount.try_to_u128().unwrap();
        self.quote_asset_reserve = new_quote_asset_amount.try_to_u128().unwrap();
    }

    pub fn find_valid_repeg(&mut self, oracle_px: i128, oracle_conf: u128) -> u128 {
        let peg_spread_0 = (self.peg_multiplier as i128)
            .checked_mul(PRICE_TO_PEG_PRECISION_RATIO as i128)
            .unwrap()
            .checked_sub(oracle_px)
            .unwrap();

        if peg_spread_0.unsigned_abs().lt(&oracle_conf) {
            return self.peg_multiplier;
        }

        let mut i = 1; // max move is half way to oracle
        let mut new_peg_candidate = self.peg_multiplier;

        while i < 20 {
            let base: i128 = 2;
            let step_fraction_size = base.pow(i);
            let step = peg_spread_0
                .checked_div(step_fraction_size)
                .unwrap()
                .checked_div(PRICE_TO_PEG_PRECISION_RATIO as i128)
                .unwrap();

            if peg_spread_0 < 0 {
                new_peg_candidate = self.peg_multiplier.checked_add(step.abs() as u128).unwrap();
            } else {
                new_peg_candidate = self.peg_multiplier.checked_sub(step.abs() as u128).unwrap();
            }

            let pnl = self.calculate_repeg_candidate_pnl(new_peg_candidate);
            let cum_pnl_profit = (self.cumulative_fee_realized as i128)
                .checked_add(pnl)
                .unwrap();

            if cum_pnl_profit >= self.cumulative_fee.checked_div(2).unwrap() as i128 {
                break;
            }

            i = i + 1;
        }

        return new_peg_candidate;
    }
}
