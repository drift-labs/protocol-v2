use crate::checked_decrement;
use crate::checked_increment;
use crate::error::ClearingHouseResult;
use crate::error::ErrorCode;
use crate::math_error;
use crate::state::spot_market::SpotMarket;
use crate::validate;
use anchor_lang::prelude::*;

#[account(zero_copy)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(packed)]
pub struct InsuranceFundStake {
    pub authority: Pubkey,
    pub market_index: u64,

    #[cfg(not(test))]
    if_shares: u128,
    #[cfg(test)]
    pub if_shares: u128, // so tests can access directly
    pub if_base: u128, // exponent for if_shares decimal places (for rebase)
    pub last_valid_ts: i64,

    pub last_withdraw_request_shares: u128, // get zero as 0 when not in escrow
    pub last_withdraw_request_value: u64,
    pub last_withdraw_request_ts: i64,

    pub cost_basis: i64,
}

impl InsuranceFundStake {
    pub fn new(authority: Pubkey, market_index: u64, now: i64) -> Self {
        InsuranceFundStake {
            authority,
            market_index,
            last_withdraw_request_shares: 0,
            last_withdraw_request_value: 0,
            last_withdraw_request_ts: 0,
            cost_basis: 0,
            if_base: 0,
            last_valid_ts: now,
            if_shares: 0,
        }
    }

    fn validate_base(&self, spot_market: &SpotMarket) -> ClearingHouseResult {
        validate!(
            self.if_base == spot_market.if_shares_base,
            ErrorCode::DefaultError,
            "if stake bases mismatch. user base: {} market base {}",
            self.if_base,
            spot_market.if_shares_base
        )?;

        Ok(())
    }

    pub fn checked_if_shares(&self, spot_market: &SpotMarket) -> ClearingHouseResult<u128> {
        self.validate_base(spot_market)?;
        Ok(self.if_shares)
    }

    pub fn unchecked_if_shares(&self) -> u128 {
        self.if_shares
    }

    pub fn increase_if_shares(
        &mut self,
        delta: u128,
        spot_market: &SpotMarket,
    ) -> ClearingHouseResult {
        self.validate_base(spot_market)?;
        checked_increment!(self.if_shares, delta);
        Ok(())
    }

    pub fn decrease_if_shares(
        &mut self,
        delta: u128,
        spot_market: &SpotMarket,
    ) -> ClearingHouseResult {
        self.validate_base(spot_market)?;
        checked_decrement!(self.if_shares, delta);
        Ok(())
    }

    pub fn update_if_shares(
        &mut self,
        new_shares: u128,
        spot_market: &SpotMarket,
    ) -> ClearingHouseResult {
        self.validate_base(spot_market)?;
        self.if_shares = new_shares;

        Ok(())
    }
}
