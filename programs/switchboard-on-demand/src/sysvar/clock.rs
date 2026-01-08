use crate::{borrow_account_data, check_pubkey_eq, get_account_key, solana_program, AsAccountInfo};

/// Optimized function to extract the slot value from a Clock sysvar.
///
/// This function extracts just the slot value from any type that implements
/// `AsAccountInfo`, making it compatible with Anchor's `Sysvar<Clock>` wrapper and pinocchio AccountInfo.
/// This is more efficient than parsing the entire Clock struct when you only need the slot.
///
/// # Arguments
/// * `clock_sysvar` - Any type that implements `AsAccountInfo` (e.g., `Sysvar<Clock>`, direct `AccountInfo` reference, pinocchio AccountInfo)
///
/// # Returns
/// The current slot value as a `u64`.
///
/// # Example with Anchor
/// ```rust,ignore
/// use anchor_lang::prelude::*;
/// use switchboard_on_demand::clock::get_slot;
///
/// pub fn my_function(ctx: Context<MyCtx>) -> Result<()> {
///     let MyCtx { sysvars, .. } = ctx.accounts;
///     let clock_slot = get_slot(&sysvars.clock);  // Works with Sysvar<Clock>
///
///     // Use the slot value
///     msg!("Current slot: {}", clock_slot);
///     Ok(())
/// }
/// ```
///
/// # Safety
/// This function uses unsafe operations to directly read from the sysvar data.
/// It is safe because it validates the account key against the Clock sysvar ID first
/// and uses unaligned reads to safely extract the slot value.
#[inline(always)]
pub fn get_slot<'a, T>(clock_sysvar: T) -> u64
where
    T: AsAccountInfo<'a>,
{
    assert!(check_pubkey_eq(
        *get_account_key!(clock_sysvar.as_account_info()),
        solana_program::sysvar::clock::ID
    ));
    unsafe {
        let clock_data = borrow_account_data!(clock_sysvar.as_account_info());
        core::ptr::read_unaligned(clock_data.as_ptr() as *const u64)
    }
}

crate::cfg_client! {
    use crate::OnDemandError;
    use futures::TryFutureExt;
    pub async fn fetch_async(
        client: &crate::RpcClient,
    ) -> std::result::Result<anchor_client::solana_sdk::sysvar::clock::Clock, crate::OnDemandError> {
        let pubkey = anchor_client::solana_sdk::sysvar::clock::id();
        let data = client
            .get_account_data(&pubkey)
            .map_err(|_| OnDemandError::AccountNotFound)
            .await?
            .to_vec();
        bincode::deserialize(&data).map_err(|_| OnDemandError::AccountNotFound)
    }
}
