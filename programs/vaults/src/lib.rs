#![allow(clippy::diverging_sub_expression, unexpected_cfgs)]
#![allow(deprecated)]

use anchor_lang::prelude::*;
use instructions::*;
use state::*;

mod constants;
mod drift_cpi;
mod error;
mod instructions;
pub mod macros;
pub mod state;
#[cfg(test)]
mod test_utils;
#[cfg(test)]
mod tests;
mod token_cpi;

declare_id!("vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR");

#[program]
pub mod vaults {
    use super::*;

    pub fn initialize_vault<'info>(
        ctx: Context<'info, InitializeVault<'info>>,
        params: VaultParams,
    ) -> Result<()> {
        instructions::initialize_vault(ctx, params)
    }

    pub fn initialize_vault_with_protocol<'info>(
        ctx: Context<'info, InitializeVaultWithProtocol<'info>>,
        params: VaultWithProtocolParams,
    ) -> Result<()> {
        instructions::initialize_vault_with_protocol(ctx, params)
    }

    pub fn update_delegate<'info>(
        ctx: Context<'info, UpdateDelegate<'info>>,
        delegate: Pubkey,
    ) -> Result<()> {
        instructions::update_delegate(ctx, delegate)
    }

    pub fn update_margin_trading_enabled<'info>(
        ctx: Context<'info, UpdateMarginTradingEnabled<'info>>,
        enabled: bool,
    ) -> Result<()> {
        instructions::update_margin_trading_enabled(ctx, enabled)
    }

    pub fn update_user_pool_id<'info>(
        ctx: Context<'info, UpdatePoolId<'info>>,
        pool_id: u8,
    ) -> Result<()> {
        instructions::update_pool_id(ctx, pool_id)
    }

    pub fn update_vault_protocol<'info>(
        ctx: Context<'info, UpdateVaultProtocol<'info>>,
        params: UpdateVaultProtocolParams,
    ) -> Result<()> {
        instructions::update_vault_protocol(ctx, params)
    }

    pub fn update_vault<'info>(
        ctx: Context<'info, UpdateVault<'info>>,
        params: UpdateVaultParams,
    ) -> Result<()> {
        instructions::update_vault(ctx, params)
    }

    pub fn update_vault_manager<'info>(
        ctx: Context<'info, UpdateVault<'info>>,
        manager: Pubkey,
    ) -> Result<()> {
        instructions::update_vault_manager(ctx, manager)
    }

    pub fn initialize_vault_depositor(ctx: Context<InitializeVaultDepositor>) -> Result<()> {
        instructions::initialize_vault_depositor(ctx)
    }

    pub fn initialize_tokenized_vault_depositor(
        ctx: Context<InitializeTokenizedVaultDepositor>,
        params: InitializeTokenizedVaultDepositorParams,
    ) -> Result<()> {
        instructions::initialize_tokenized_vault_depositor(ctx, params)
    }

    pub fn tokenize_shares<'info>(
        ctx: Context<'info, TokenizeShares<'info>>,
        amount: u64,
        unit: WithdrawUnit,
    ) -> Result<()> {
        instructions::tokenize_shares(ctx, amount, unit)
    }

    pub fn redeem_tokens<'info>(
        ctx: Context<'info, RedeemTokens<'info>>,
        tokens_to_burn: u64,
    ) -> Result<()> {
        instructions::redeem_tokens(ctx, tokens_to_burn)
    }

    pub fn deposit<'info>(ctx: Context<'info, Deposit<'info>>, amount: u64) -> Result<()> {
        instructions::deposit(ctx, amount)
    }

    pub fn request_withdraw<'info>(
        ctx: Context<'info, RequestWithdraw<'info>>,
        withdraw_amount: u64,
        withdraw_unit: WithdrawUnit,
    ) -> Result<()> {
        instructions::request_withdraw(ctx, withdraw_amount, withdraw_unit)
    }

    pub fn cancel_request_withdraw<'info>(
        ctx: Context<'info, CancelWithdrawRequest<'info>>,
    ) -> Result<()> {
        instructions::cancel_withdraw_request(ctx)
    }

    pub fn withdraw<'info>(ctx: Context<'info, Withdraw<'info>>) -> Result<()> {
        instructions::withdraw(ctx)
    }

    pub fn liquidate<'info>(ctx: Context<'info, Liquidate<'info>>) -> Result<()> {
        instructions::liquidate(ctx)
    }

    pub fn reset_delegate<'info>(ctx: Context<'info, ResetDelegate<'info>>) -> Result<()> {
        instructions::reset_delegate(ctx)
    }

    pub fn manager_borrow<'info>(
        ctx: Context<'info, ManagerBorrow<'info>>,
        borrow_spot_market_index: u16,
        borrow_amount: u64,
    ) -> Result<()> {
        instructions::manager_borrow(ctx, borrow_spot_market_index, borrow_amount)
    }

    pub fn manager_repay<'info>(
        ctx: Context<'info, ManagerRepay<'info>>,
        repay_spot_market_index: u16,
        repay_amount: u64,
        repay_value: Option<u64>,
    ) -> Result<()> {
        instructions::manager_repay(ctx, repay_spot_market_index, repay_amount, repay_value)
    }

    pub fn manager_update_borrow<'info>(
        ctx: Context<'info, ManagerUpdateBorrow<'info>>,
        new_borrow_value: u64,
    ) -> Result<()> {
        instructions::manager_update_borrow(ctx, new_borrow_value)
    }

    pub fn manager_deposit<'info>(
        ctx: Context<'info, ManagerDeposit<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::manager_deposit(ctx, amount)
    }

    pub fn manager_request_withdraw<'info>(
        ctx: Context<'info, ManagerRequestWithdraw<'info>>,
        withdraw_amount: u64,
        withdraw_unit: WithdrawUnit,
    ) -> Result<()> {
        instructions::manager_request_withdraw(ctx, withdraw_amount, withdraw_unit)
    }

    pub fn manger_cancel_withdraw_request<'info>(
        ctx: Context<'info, ManagerCancelWithdrawRequest<'info>>,
    ) -> Result<()> {
        instructions::manager_cancel_withdraw_request(ctx)
    }

    pub fn manager_withdraw<'info>(ctx: Context<'info, ManagerWithdraw<'info>>) -> Result<()> {
        instructions::manager_withdraw(ctx)
    }

    pub fn admin_init_fee_update<'info>(
        ctx: Context<'info, AdminInitFeeUpdate<'info>>,
    ) -> Result<()> {
        instructions::admin_init_fee_update(ctx)
    }

    pub fn admin_delete_fee_update<'info>(
        ctx: Context<'info, AdminDeleteFeeUpdate<'info>>,
    ) -> Result<()> {
        instructions::admin_delete_fee_update(ctx)
    }

    pub fn admin_update_vault_class<'info>(
        ctx: Context<'info, AdminUpdateVaultClass<'info>>,
        new_vault_class: u8,
    ) -> Result<()> {
        instructions::admin_update_vault_class(ctx, new_vault_class)
    }

    pub fn manager_update_fees<'info>(
        ctx: Context<'info, ManagerUpdateFees<'info>>,
        params: ManagerUpdateFeesParams,
    ) -> Result<()> {
        instructions::manager_update_fees(ctx, params)
    }

    pub fn manager_cancel_fee_update<'info>(
        ctx: Context<'info, ManagerCancelFeeUpdate<'info>>,
    ) -> Result<()> {
        instructions::manager_cancel_fee_update(ctx)
    }

    pub fn apply_profit_share<'info>(ctx: Context<'info, ApplyProfitShare<'info>>) -> Result<()> {
        instructions::apply_profit_share(ctx)
    }

    pub fn apply_rebase<'info>(ctx: Context<'info, ApplyRebase<'info>>) -> Result<()> {
        instructions::apply_rebase(ctx)
    }

    pub fn apply_rebase_tokenized_depositor<'info>(
        ctx: Context<'info, ApplyRebaseTokenizedDepositor<'info>>,
    ) -> Result<()> {
        instructions::apply_rebase_tokenized_depositor(ctx)
    }

    pub fn force_withdraw<'info>(ctx: Context<'info, ForceWithdraw<'info>>) -> Result<()> {
        instructions::force_withdraw(ctx)
    }

    pub fn initialize_insurance_fund_stake<'info>(
        ctx: Context<'info, InitializeInsuranceFundStake<'info>>,
        market_index: u16,
    ) -> Result<()> {
        instructions::initialize_insurance_fund_stake(ctx, market_index)
    }

    pub fn add_insurance_fund_stake<'info>(
        ctx: Context<'info, AddInsuranceFundStake<'info>>,
        market_index: u16,
        amount: u64,
    ) -> Result<()> {
        instructions::add_insurance_fund_stake(ctx, market_index, amount)
    }

    pub fn request_remove_insurance_fund_stake<'info>(
        ctx: Context<'info, RequestRemoveInsuranceFundStake<'info>>,
        market_index: u16,
        amount: u64,
    ) -> Result<()> {
        instructions::request_remove_insurance_fund_stake(ctx, market_index, amount)
    }

    pub fn remove_insurance_fund_stake<'info>(
        ctx: Context<'info, RemoveInsuranceFundStake<'info>>,
        market_index: u16,
    ) -> Result<()> {
        instructions::remove_insurance_fund_stake(ctx, market_index)
    }

    pub fn cancel_request_remove_insurance_fund_stake<'info>(
        ctx: Context<'info, RequestRemoveInsuranceFundStake<'info>>,
        market_index: u16,
    ) -> Result<()> {
        instructions::cancel_request_remove_insurance_fund_stake(ctx, market_index)
    }

    pub fn transfer_vault_depositor_shares<'info>(
        ctx: Context<'info, TransferVaultDepositorShares<'info>>,
        amount: u64,
        withdraw_unit: WithdrawUnit,
    ) -> Result<()> {
        instructions::transfer_vault_depositor_shares(ctx, amount, withdraw_unit)
    }

    pub fn protocol_request_withdraw<'info>(
        ctx: Context<'info, ProtocolRequestWithdraw<'info>>,
        withdraw_amount: u64,
        withdraw_unit: WithdrawUnit,
    ) -> Result<()> {
        instructions::protocol_request_withdraw(ctx, withdraw_amount, withdraw_unit)
    }

    pub fn protocol_cancel_withdraw_request<'info>(
        ctx: Context<'info, ProtocolCancelWithdrawRequest<'info>>,
    ) -> Result<()> {
        instructions::protocol_cancel_withdraw_request(ctx)
    }

    pub fn protocol_withdraw<'info>(ctx: Context<'info, ProtocolWithdraw<'info>>) -> Result<()> {
        instructions::protocol_withdraw(ctx)
    }
}
