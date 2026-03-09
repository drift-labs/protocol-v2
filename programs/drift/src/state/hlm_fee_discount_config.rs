use anchor_lang::prelude::*;

use crate::error::{DriftResult, ErrorCode};
use crate::state::traits::Size;
use crate::validate;

pub const HLM_FEE_DISCOUNT_MAX_AUTHORITIES: usize = 8;

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct HlmFeeDiscountConfig {
    pub whitelisted_authorities: [Pubkey; HLM_FEE_DISCOUNT_MAX_AUTHORITIES],
    pub padding: [u8; 32],
}

impl Size for HlmFeeDiscountConfig {
    const SIZE: usize = 296;
}

impl HlmFeeDiscountConfig {
    pub fn is_whitelisted(&self, authority: &Pubkey) -> bool {
        *authority != Pubkey::default() && self.whitelisted_authorities.contains(authority)
    }

    pub fn update_whitelisted_authorities(
        &mut self,
        whitelisted_authorities: [Pubkey; HLM_FEE_DISCOUNT_MAX_AUTHORITIES],
    ) -> DriftResult {
        for i in 0..HLM_FEE_DISCOUNT_MAX_AUTHORITIES {
            let authority = whitelisted_authorities[i];
            if authority == Pubkey::default() {
                continue;
            }

            validate!(
                !whitelisted_authorities[i + 1..].contains(&authority),
                ErrorCode::InvalidHlmFeeDiscountConfig,
                "duplicate whitelisted authority {:?}",
                authority
            )?;
        }

        self.whitelisted_authorities = whitelisted_authorities;

        Ok(())
    }
}
