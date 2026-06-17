use crate::events::{FeeUpdateAction, FeeUpdateRecord};
use crate::state::{FeeUpdateStatus, Vault};
use crate::Size;
use anchor_lang::prelude::*;
use drift_macros::assert_no_slop;
use static_assertions::const_assert_eq;

#[assert_no_slop]
#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct FeeUpdate {
    pub padding: [u128; 10],
    pub incoming_update_ts: i64,
    pub incoming_management_fee: i64,
    pub incoming_profit_share: u32,
    pub incoming_hurdle_rate: u32,
    pub padding2: [u8; 8],
}

impl Size for FeeUpdate {
    const SIZE: usize = 192 + 8;
}
const_assert_eq!(FeeUpdate::SIZE, std::mem::size_of::<FeeUpdate>() + 8);

impl FeeUpdate {
    pub fn reset(&mut self) {
        self.incoming_update_ts = 0;
        self.incoming_management_fee = 0;
        self.incoming_profit_share = 0;
        self.incoming_hurdle_rate = 0;
    }

    pub fn is_pending(&self) -> bool {
        self.incoming_update_ts > 0
    }

    pub fn try_update_vault_fees(&mut self, now: i64, vault: &mut Vault) -> Result<()> {
        if !self.is_pending() {
            return Ok(());
        }

        if now >= self.incoming_update_ts {
            emit!(FeeUpdateRecord {
                ts: now,
                action: FeeUpdateAction::Applied,
                timelock_end_ts: self.incoming_update_ts,
                vault: vault.pubkey,
                old_management_fee: vault.management_fee,
                old_profit_share: vault.profit_share,
                old_hurdle_rate: vault.hurdle_rate,
                new_management_fee: self.incoming_management_fee,
                new_profit_share: self.incoming_profit_share,
                new_hurdle_rate: self.incoming_hurdle_rate,
            });

            vault.management_fee = self.incoming_management_fee;
            vault.profit_share = self.incoming_profit_share;
            vault.hurdle_rate = self.incoming_hurdle_rate;

            vault.fee_update_status = FeeUpdateStatus::None as u8;

            self.reset();
        }

        Ok(())
    }
}
