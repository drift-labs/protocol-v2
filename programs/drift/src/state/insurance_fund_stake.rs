use crate::error::DriftResult;
use crate::error::ErrorCode;
use crate::math::constants::EPOCH_DURATION;
use crate::math::safe_math::SafeMath;
use crate::math_error;
use crate::safe_decrement;
use crate::safe_increment;
use crate::state::spot_market::SpotMarket;
use crate::state::traits::Size;
use crate::validate;
use anchor_lang::prelude::*;

#[cfg(test)]
mod tests;

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct InsuranceFundStake {
    pub authority: Pubkey,
    if_shares: u128,
    pub last_withdraw_request_shares: u128, // get zero as 0 when not in escrow
    pub if_base: u128,                      // exponent for if_shares decimal places (for rebase)
    pub last_valid_ts: i64,
    pub last_withdraw_request_value: u64,
    pub last_withdraw_request_ts: i64,
    pub cost_basis: i64,
    pub market_index: u16,
    pub padding: [u8; 14],
}

// implement SIZE const for InsuranceFundStake
impl Size for InsuranceFundStake {
    const SIZE: usize = 136;
}

impl InsuranceFundStake {
    pub fn new(authority: Pubkey, market_index: u16, now: i64) -> Self {
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
            padding: [0; 14],
        }
    }

    fn validate_base(&self, spot_market: &SpotMarket) -> DriftResult {
        validate!(
            self.if_base == spot_market.insurance_fund.shares_base,
            ErrorCode::InvalidIFRebase,
            "if stake bases mismatch. user base: {} market base {}",
            self.if_base,
            spot_market.insurance_fund.shares_base
        )?;

        Ok(())
    }

    pub fn checked_if_shares(&self, spot_market: &SpotMarket) -> DriftResult<u128> {
        self.validate_base(spot_market)?;
        Ok(self.if_shares)
    }

    pub fn unchecked_if_shares(&self) -> u128 {
        self.if_shares
    }

    pub fn increase_if_shares(&mut self, delta: u128, spot_market: &SpotMarket) -> DriftResult {
        self.validate_base(spot_market)?;
        safe_increment!(self.if_shares, delta);
        Ok(())
    }

    pub fn decrease_if_shares(&mut self, delta: u128, spot_market: &SpotMarket) -> DriftResult {
        self.validate_base(spot_market)?;
        safe_decrement!(self.if_shares, delta);
        Ok(())
    }

    pub fn update_if_shares(&mut self, new_shares: u128, spot_market: &SpotMarket) -> DriftResult {
        self.validate_base(spot_market)?;
        self.if_shares = new_shares;

        Ok(())
    }
}

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct ProtocolIfSharesTransferConfig {
    pub whitelisted_signers: [Pubkey; 4],
    pub max_transfer_per_epoch: u128,
    pub current_epoch_transfer: u128,
    pub next_epoch_ts: i64,
    pub padding: [u128; 8],
}

// implement SIZE const for ProtocolIfSharesTransferConfig
impl Size for ProtocolIfSharesTransferConfig {
    const SIZE: usize = 304;
}

impl ProtocolIfSharesTransferConfig {
    pub fn validate_signer(&self, signer: &Pubkey) -> DriftResult {
        validate!(
            self.whitelisted_signers.contains(signer) && *signer != Pubkey::default(),
            ErrorCode::DefaultError,
            "signer {} not whitelisted",
            signer
        )?;

        Ok(())
    }

    pub fn update_epoch(&mut self, now: i64) -> DriftResult {
        if now > self.next_epoch_ts {
            let n_epoch_durations = now
                .safe_sub(self.next_epoch_ts)?
                .safe_div(EPOCH_DURATION)?
                .safe_add(1)?;

            self.next_epoch_ts = self
                .next_epoch_ts
                .safe_add(EPOCH_DURATION.safe_mul(n_epoch_durations)?)?;

            self.current_epoch_transfer = 0;
        }

        Ok(())
    }

    pub fn validate_transfer(&self, requested_transfer: u128) -> DriftResult {
        let max_transfer = self
            .max_transfer_per_epoch
            .saturating_sub(self.current_epoch_transfer);

        validate!(
            requested_transfer < max_transfer,
            ErrorCode::DefaultError,
            "requested transfer {} exceeds max transfer {}",
            requested_transfer,
            max_transfer
        )?;

        Ok(())
    }
}
