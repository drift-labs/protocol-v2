use anchor_lang::prelude::Context;
use std::collections::BTreeSet;
use velocity::error::VelocityResult;
use velocity::instructions::optional_accounts::{load_maps, AccountMaps};
use velocity::state::spot_market_map::get_writable_spot_market_set;

use crate::state::FeeUpdate;
use crate::state::VaultProtocol;
use anchor_lang::prelude::*;

pub trait AccountMapProvider<'a> {
    fn load_maps(
        &self,
        slot: u64,
        writable_spot_market: Option<u16>,
        has_vault_protocol: bool,
        has_fee_update: bool,
    ) -> VelocityResult<AccountMaps<'a>>;
}

impl<'info, T: anchor_lang::Bumps> AccountMapProvider<'info> for Context<'info, T> {
    fn load_maps(
        &self,
        slot: u64,
        writable_spot_market_index: Option<u16>,
        has_vault_protocol: bool,
        has_fee_update: bool,
    ) -> VelocityResult<AccountMaps<'info>> {
        // if [`VaultProtocol`] exists it will be the last index in the remaining_accounts, so we need to skip it.
        let mut end_index = self.remaining_accounts.len() - (has_vault_protocol as usize);
        // if there is a [`FeeUpdate`], we need to skip one more account
        end_index -= has_fee_update as usize;

        let remaining_accounts_iter = &mut self.remaining_accounts[..end_index].iter().peekable();
        load_maps(
            remaining_accounts_iter,
            &BTreeSet::new(),
            &writable_spot_market_index
                .map(get_writable_spot_market_set)
                .unwrap_or_default(),
            slot,
            None,
        )
    }
}

pub trait VaultProtocolProvider<'a> {
    fn vault_protocol(&self) -> Option<AccountLoader<'a, VaultProtocol>>;
}

/// Provides the last remaining account as a [`VaultProtocol`].
impl<'info, T: anchor_lang::Bumps> VaultProtocolProvider<'info> for Context<'info, T> {
    fn vault_protocol(&self) -> Option<AccountLoader<'info, VaultProtocol>> {
        let acct = self.remaining_accounts.last()?;
        AccountLoader::<'info, VaultProtocol>::try_from(acct).ok()
    }
}

pub trait FeeUpdateProvider<'a> {
    fn fee_update(
        &self,
        has_vp: bool,
        has_fee_update: bool,
    ) -> Option<AccountLoader<'a, FeeUpdate>>;
}

/// Provides [`FeeUpdate`] from remaining_accounts, respects whether the vault has a VaultProtocol.
impl<'info, T: anchor_lang::Bumps> FeeUpdateProvider<'info> for Context<'info, T> {
    fn fee_update(
        &self,
        has_vp: bool,
        has_fee_update: bool,
    ) -> Option<AccountLoader<'info, FeeUpdate>> {
        if !has_fee_update {
            None
        } else {
            let acct_idx = if has_vp {
                // if there is a [`VaultProtocol`], the [`FeeUpdate`] is the second to last account
                self.remaining_accounts.len() - 2
            } else {
                // otherwise [`FeeUpdate`] is the last account
                self.remaining_accounts.len() - 1
            };
            let acct = self.remaining_accounts.get(acct_idx)?;

            AccountLoader::<'info, FeeUpdate>::try_from(acct).ok()
        }
    }
}
