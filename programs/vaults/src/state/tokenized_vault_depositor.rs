use std::cell::RefMut;

use crate::error::ErrorCode;
use crate::events::{VaultDepositorAction, VaultDepositorRecord, VaultDepositorV1Record};
use crate::state::vault::Vault;
use crate::{validate, FeeUpdate, VaultFee, VaultProtocol};
use crate::{Size, VaultDepositorBase};
use static_assertions::const_assert_eq;

use anchor_lang::prelude::*;
use drift::math::casting::Cast;
use drift::math::insurance::{
    if_shares_to_vault_amount as depositor_shares_to_vault_amount,
    vault_amount_to_if_shares as vault_amount_to_depositor_shares,
};
use drift::math::safe_math::SafeMath;
use drift_macros::assert_no_slop;

#[assert_no_slop]
#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct TokenizedVaultDepositor {
    /// The vault deposited into
    pub vault: Pubkey,
    /// The vault depositor account's pubkey. It is a pda of vault
    pub pubkey: Pubkey,
    /// The token mint for tokenized shares owned by this VaultDepositor
    pub mint: Pubkey,
    /// share of vault owned by this depositor. vault_shares / vault.total_shares is depositor's ownership of vault_equity
    vault_shares: u128,
    /// stores the vault_shares from the most recent liquidity event (redeem or issuance) before a spl token
    /// CPI is done, used to track invariants
    last_vault_shares: u128,
    /// creation ts of vault depositor
    pub last_valid_ts: i64,
    /// lifetime net deposits of vault depositor for the vault
    pub net_deposits: i64,

    /// lifetime total deposits
    pub total_deposits: u64,
    /// lifetime total withdraws
    pub total_withdraws: u64,
    /// the token amount of gains the vault depositor has paid performance fees on
    pub cumulative_profit_share_amount: i64,
    pub profit_share_fee_paid: u64,
    /// The exponent for vault_shares decimal places at the time the tokenized vault depositor was initialized.
    /// If the vault undergoes a rebase, this TokenizedVaultDepositor can no longer issue new tokens, only redeem
    /// is possible.
    pub vault_shares_base: u32,
    /// The bump for the vault pda
    pub bump: u8,
    pub padding1: [u8; 3],
    pub padding: [u64; 11],
}

impl Size for TokenizedVaultDepositor {
    const SIZE: usize = 272 + 8;
}

const_assert_eq!(
    TokenizedVaultDepositor::SIZE,
    std::mem::size_of::<TokenizedVaultDepositor>() + 8
);

impl VaultDepositorBase for TokenizedVaultDepositor {
    fn get_authority(&self) -> Pubkey {
        self.vault
    }
    fn get_pubkey(&self) -> Pubkey {
        self.pubkey
    }

    fn get_vault_shares(&self) -> u128 {
        self.vault_shares
    }
    fn set_vault_shares(&mut self, shares: u128) {
        self.vault_shares = shares;
    }

    fn get_vault_shares_base(&self) -> u32 {
        self.vault_shares_base
    }
    fn set_vault_shares_base(&mut self, base: u32) {
        self.vault_shares_base = base;
    }

    fn get_net_deposits(&self) -> i64 {
        self.net_deposits
    }
    fn set_net_deposits(&mut self, amount: i64) {
        self.net_deposits = amount;
    }

    fn get_cumulative_profit_share_amount(&self) -> i64 {
        self.cumulative_profit_share_amount
    }
    fn set_cumulative_profit_share_amount(&mut self, amount: i64) {
        self.cumulative_profit_share_amount = amount;
    }

    fn get_profit_share_fee_paid(&self) -> u64 {
        self.profit_share_fee_paid
    }
    fn set_profit_share_fee_paid(&mut self, amount: u64) {
        self.profit_share_fee_paid = amount;
    }
}

impl TokenizedVaultDepositor {
    pub fn new(
        vault: Pubkey,
        pubkey: Pubkey,
        mint: Pubkey,
        vault_shares_base: u32,
        bump: u8,
        now: i64,
    ) -> Self {
        Self {
            vault,
            pubkey,
            mint,
            vault_shares: 0,
            last_vault_shares: 0,
            last_valid_ts: now,
            net_deposits: 0,
            total_deposits: 0,
            total_withdraws: 0,
            cumulative_profit_share_amount: 0,
            profit_share_fee_paid: 0,
            vault_shares_base,
            bump,
            padding1: [0; 3],
            padding: [0; 11],
        }
    }

    fn apply_rebase(
        &mut self,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        vault_equity: u64,
    ) -> Result<Option<u128>> {
        if let Some(rebase_divisor) =
            VaultDepositorBase::apply_rebase(self, vault, vault_protocol, vault_equity)?
        {
            self.last_vault_shares = self.get_vault_shares();
            Ok(Some(rebase_divisor))
        } else {
            Ok(None)
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn tokenize_shares(
        self: &mut TokenizedVaultDepositor,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        mint_supply: u64,
        vault_equity: u64,
        shares_transferred: u128,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<u64> {
        let rebase_divisor = self.apply_rebase(vault, vault_protocol, vault_equity)?;
        if rebase_divisor.is_some() {
            return Err(ErrorCode::InvalidVaultRebase.into());
        }

        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = vault.apply_fee(vault_protocol, fee_update, vault_equity, now)?;
        let (manager_profit_share, protocol_profit_share) =
            self.apply_profit_share(vault_equity, vault, vault_protocol)?;

        let vault_shares_before = self.checked_vault_shares(vault)?;
        let total_vault_shares_before = vault.total_shares;
        let user_vault_shares_before = vault.user_shares;
        let protocol_shares_before = vault.get_protocol_shares(vault_protocol);

        let new_last_vault_shares = self.last_vault_shares.safe_add(shares_transferred)?;

        validate!(
            new_last_vault_shares == vault_shares_before,
            ErrorCode::InvalidVaultSharesDetected,
            "TokenizedVaultDepositor: last_vault_shares + shares_transferred != vault_shares, {} != {}",
            new_last_vault_shares,
            vault_shares_before
        )?;

        let tokens_to_mint = vault_amount_to_depositor_shares(
            shares_transferred.cast()?,
            mint_supply.cast()?,
            self.last_vault_shares.cast()?,
        )?;

        msg!(
            "shares_transferred: {}, tokenized_vd.last_vault_shares: {}, token_supply_before: {}, tokens_to_mint: {}",
            shares_transferred,
            self.last_vault_shares,
            mint_supply,
            tokens_to_mint
        );

        self.last_vault_shares = self.checked_vault_shares(vault)?;

        match vault_protocol {
            None => {
                emit!(VaultDepositorRecord {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: vault.pubkey,
                    action: VaultDepositorAction::TokenizeShares,
                    amount: shares_transferred.cast()?,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after: self.last_vault_shares,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    profit_share: manager_profit_share
                        .safe_add(protocol_profit_share)?
                        .cast()?,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    deposit_oracle_price,
                });
            }
            Some(_) => {
                emit!(VaultDepositorV1Record {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: vault.pubkey,
                    action: VaultDepositorAction::TokenizeShares,
                    amount: shares_transferred.cast()?,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after: self.last_vault_shares,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    protocol_profit_share,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    manager_profit_share,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after: vault.get_protocol_shares(vault_protocol),
                    deposit_oracle_price,
                });
            }
        }

        Ok(tokens_to_mint.cast()?)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn redeem_tokens<'a>(
        self: &mut TokenizedVaultDepositor,
        vault: &mut Vault,
        vault_protocol: &mut Option<RefMut<'a, VaultProtocol>>,
        fee_update: &mut Option<AccountLoader<FeeUpdate>>,
        mint_supply: u64,
        vault_equity: u64,
        tokens_to_burn: u64,
        now: i64,
        deposit_oracle_price: i64,
    ) -> Result<(u64, Option<RefMut<'a, VaultProtocol>>)> {
        self.apply_rebase(vault, vault_protocol, vault_equity)?;

        let VaultFee {
            management_fee_payment,
            management_fee_shares,
            protocol_fee_payment,
            protocol_fee_shares,
        } = vault.apply_fee(vault_protocol, fee_update, vault_equity, now)?;
        let (manager_profit_share, protocol_profit_share) =
            self.apply_profit_share(vault_equity, vault, vault_protocol)?;

        let vault_shares_before = self.checked_vault_shares(vault)?;
        let total_vault_shares_before = vault.total_shares;
        let user_vault_shares_before = vault.user_shares;
        let protocol_shares_before = vault.get_protocol_shares(vault_protocol);

        self.last_vault_shares = self.checked_vault_shares(vault)?;

        let shares_to_redeem = depositor_shares_to_vault_amount(
            tokens_to_burn.cast()?,
            mint_supply.cast()?,
            self.last_vault_shares.cast()?,
        )?;

        msg!(
            "tokens_to_burn: {}, tokenized_vd.vault_shares: {}, token_supply_before: {}, shares_to_redeem: {}",
            tokens_to_burn,
            self.last_vault_shares,
            mint_supply,
            shares_to_redeem
        );

        match vault_protocol {
            None => {
                emit!(VaultDepositorRecord {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: vault.pubkey,
                    action: VaultDepositorAction::RedeemTokens,
                    amount: tokens_to_burn,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after: self.last_vault_shares,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    profit_share: manager_profit_share
                        .safe_add(protocol_profit_share)?
                        .cast()?,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    deposit_oracle_price
                });
            }
            Some(_) => {
                emit!(VaultDepositorV1Record {
                    ts: now,
                    vault: vault.pubkey,
                    depositor_authority: vault.pubkey,
                    action: VaultDepositorAction::RedeemTokens,
                    amount: tokens_to_burn,
                    spot_market_index: vault.spot_market_index,
                    vault_equity_before: vault_equity,
                    vault_shares_before,
                    user_vault_shares_before,
                    total_vault_shares_before,
                    vault_shares_after: self.vault_shares,
                    total_vault_shares_after: vault.total_shares,
                    user_vault_shares_after: vault.user_shares,
                    protocol_profit_share,
                    protocol_fee: protocol_fee_payment,
                    protocol_fee_shares,
                    manager_profit_share,
                    management_fee: management_fee_payment,
                    management_fee_shares,
                    protocol_shares_before,
                    protocol_shares_after: vault.get_protocol_shares(vault_protocol),
                    deposit_oracle_price
                });
            }
        }

        Ok((shares_to_redeem, vault_protocol.take()))
    }
}

#[cfg(test)]
mod tests {
    use crate::{TokenizedVaultDepositor, Vault, VaultDepositorBase};
    use anchor_lang::prelude::Pubkey;
    use drift::math::constants::PERCENTAGE_PRECISION;
    use drift::math::safe_math::SafeMath;

    #[test]
    fn test_tokenize_shares() {
        let now = 1337;
        let vault = &mut Vault::default();
        let mut tvd = TokenizedVaultDepositor::new(
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            0,
            0,
            now,
        );
        let mut shares_transferred = 100_000;
        tvd.vault_shares = tvd.last_vault_shares + shares_transferred;

        assert_eq!(tvd.last_vault_shares, 0);

        let mut total_supply = 0;
        let vault_equity = 1_000_000;
        let tokens_issued_1 = tvd
            .tokenize_shares(
                vault,
                &mut None,
                &mut None,
                total_supply,
                vault_equity,
                shares_transferred,
                now,
                0,
            )
            .unwrap();

        // first tokenization will issue same amount of tokens as shares
        assert_eq!(tokens_issued_1, shares_transferred as u64);
        assert_eq!(tvd.last_vault_shares, tvd.vault_shares);

        // emulate minting tokens
        total_supply += tokens_issued_1;

        // second tokenization is double the shares of first issuance``
        shares_transferred *= 2;
        tvd.vault_shares = tvd.last_vault_shares + shares_transferred;

        let tokens_issued_2 = tvd
            .tokenize_shares(
                vault,
                &mut None,
                &mut None,
                total_supply,
                vault_equity,
                shares_transferred,
                now,
                0,
            )
            .unwrap();

        // first tokenization will issue same amount of tokens as shares
        assert_eq!(tokens_issued_2, tokens_issued_1 * 2);
        assert_eq!(tvd.last_vault_shares, tvd.vault_shares);
        assert_eq!(
            tvd.vault_shares,
            (tokens_issued_1 + tokens_issued_2) as u128
        );
    }

    #[test]
    fn test_redeem_tokens() {
        let now = 1337;
        let vault = &mut Vault::default();
        let mut tvd = TokenizedVaultDepositor::new(
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            0,
            0,
            now,
        );
        let shares_transferred = 500_000;
        tvd.vault_shares = shares_transferred;
        tvd.last_vault_shares = tvd.vault_shares;

        assert_eq!(tvd.last_vault_shares, shares_transferred);

        let total_supply = shares_transferred;
        let vault_equity = 1_000_000;

        // redeem 50% of tokens
        let tokens_to_burn = total_supply / 2;
        let shares_to_transfer = tvd
            .redeem_tokens(
                vault,
                &mut None,
                &mut None,
                total_supply as u64,
                vault_equity,
                tokens_to_burn as u64,
                now,
                0,
            )
            .expect("redeem_tokens");
        assert_eq!(shares_to_transfer.0, tokens_to_burn as u64);
        assert_eq!(tvd.last_vault_shares, tvd.vault_shares);
    }

    #[test]
    fn test_tokenize_shares_with_rebase() {
        let mut now = 1337;
        let vault = &mut Vault::default();
        let mut tvd = TokenizedVaultDepositor::new(
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            0,
            0,
            now,
        );
        let shares_transferred = 100_000;
        tvd.vault_shares = tvd.last_vault_shares + shares_transferred;

        assert_eq!(tvd.last_vault_shares, 0);

        let mut total_supply = 0;
        let mut vault_equity = 1_000_000;
        let tokens_issued_1 = tvd
            .tokenize_shares(
                vault,
                &mut None,
                &mut None,
                total_supply,
                vault_equity,
                shares_transferred,
                now,
                0,
            )
            .unwrap();

        // first tokenization will issue same amount of tokens as shares
        assert_eq!(tokens_issued_1, shares_transferred as u64);
        assert_eq!(tvd.last_vault_shares, tvd.vault_shares);

        // emulate minting tokens
        total_supply += tokens_issued_1;

        // second tokenization happens after vault down 99.9%
        vault_equity /= 1000;
        now += 100;

        tvd.vault_shares = tvd.last_vault_shares + shares_transferred;

        // will trigger rebase
        let tokens_issued_2 = tvd.tokenize_shares(
            vault,
            &mut None,
            &mut None,
            total_supply,
            vault_equity,
            shares_transferred,
            now,
            0,
        );

        assert!(
            tokens_issued_2.is_err(),
            "disallow tokenize_shares on rebase"
        );
    }

    #[test]
    fn test_tokenize_shares_with_profit_share() {
        let now = 1337;
        let vault = &mut Vault::default();
        let profit_share_pct = 10u64;
        vault.profit_share = PERCENTAGE_PRECISION
            .safe_div(profit_share_pct as u128)
            .unwrap() as u32;
        let mut tvd = TokenizedVaultDepositor::new(
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            0,
            0,
            now,
        );

        let total_supply = 0;
        let vault_equity = 1_000_000u64;
        let shares_transferred = 100_000;

        vault.user_shares = shares_transferred;
        vault.total_shares = shares_transferred;
        tvd.vault_shares = tvd.last_vault_shares + shares_transferred;
        tvd.net_deposits = vault_equity as i64;

        assert_eq!(tvd.last_vault_shares, 0);

        let tokens_issued_1 = tvd
            .tokenize_shares(
                vault,
                &mut None,
                &mut None,
                total_supply,
                vault_equity,
                shares_transferred,
                now,
                0,
            )
            .unwrap();

        // first tokenization will issue same amount of tokens as shares
        assert_eq!(tokens_issued_1, shares_transferred as u64);
        assert_eq!(tvd.last_vault_shares, tvd.vault_shares);

        let profit = vault_equity * profit_share_pct * 2 / 100;
        println!("profit: {}", profit);

        let tvd_shares_before = tvd.get_vault_shares();
        let (manager_profit_share, protocol_profit_share) = tvd
            .apply_profit_share(vault_equity + profit, vault, &mut None)
            .unwrap();
        let tvd_shares_after = tvd.get_vault_shares();

        println!(
            "tvd_shares_before: {}, tvd_shares_after: {}",
            tvd_shares_before, tvd_shares_after
        );

        assert_eq!(
            manager_profit_share + protocol_profit_share,
            profit * profit_share_pct / 100
        );
        assert!(
            tvd_shares_after < tvd_shares_before,
            "tvd shares should decrease after profit share"
        );
    }
}
