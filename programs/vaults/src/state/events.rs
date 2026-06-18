use anchor_lang::prelude::*;

#[event]
#[derive(Default)]
pub struct VaultRecord {
    pub ts: i64,
    pub spot_market_index: u16,
    pub vault_equity_before: u64,
}

#[event]
#[derive(Default)]
pub struct VaultDepositorRecord {
    pub ts: i64,
    pub vault: Pubkey,
    pub depositor_authority: Pubkey,
    pub action: VaultDepositorAction,
    pub amount: u64,

    pub spot_market_index: u16,
    pub vault_shares_before: u128,
    pub vault_shares_after: u128,

    pub vault_equity_before: u64,

    pub user_vault_shares_before: u128,
    pub total_vault_shares_before: u128,

    pub user_vault_shares_after: u128,
    pub total_vault_shares_after: u128,

    pub profit_share: u64,
    pub management_fee: i64,
    pub management_fee_shares: i64,

    /// precision: PRICE_PRECISION
    pub deposit_oracle_price: i64,
}

#[event]
#[derive(Default)]
pub struct VaultDepositorV1Record {
    pub ts: i64,
    pub vault: Pubkey,
    pub depositor_authority: Pubkey,
    pub action: VaultDepositorAction,
    pub amount: u64,

    pub spot_market_index: u16,
    pub vault_shares_before: u128,
    pub vault_shares_after: u128,

    pub vault_equity_before: u64,

    pub user_vault_shares_before: u128,
    pub total_vault_shares_before: u128,

    pub user_vault_shares_after: u128,
    pub total_vault_shares_after: u128,

    pub protocol_shares_before: u128,
    pub protocol_shares_after: u128,

    pub protocol_profit_share: u64,
    pub protocol_fee: i64,
    pub protocol_fee_shares: i64,

    pub manager_profit_share: u64,
    pub management_fee: i64,
    pub management_fee_shares: i64,

    /// precision: PRICE_PRECISION
    pub deposit_oracle_price: i64,
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq, Default)]
pub enum VaultDepositorAction {
    #[default]
    Deposit,
    WithdrawRequest,
    CancelWithdrawRequest,
    Withdraw,
    FeePayment,
    TokenizeShares,
    RedeemTokens,
}

#[event]
#[derive(Default)]
pub struct ShareTransferRecord {
    pub ts: i64,
    pub vault: Pubkey,
    pub from_vault_depositor: Pubkey,
    pub to_vault_depositor: Pubkey,
    pub shares: u128,
    pub value: u64,
    pub from_depositor_shares_before: u128,
    pub from_depositor_shares_after: u128,
    pub to_depositor_shares_before: u128,
    pub to_depositor_shares_after: u128,
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub enum FeeUpdateAction {
    Pending,
    Applied,
    Cancelled,
}

#[event]
pub struct FeeUpdateRecord {
    pub ts: i64,
    pub action: FeeUpdateAction,
    pub timelock_end_ts: i64,
    pub vault: Pubkey,
    pub old_management_fee: i64,
    pub old_profit_share: u32,
    pub old_hurdle_rate: u32,
    pub new_management_fee: i64,
    pub new_profit_share: u32,
    pub new_hurdle_rate: u32,
}

#[event]
pub struct ManagerBorrowRecord {
    pub ts: i64,
    pub vault: Pubkey,
    pub manager: Pubkey,
    pub borrow_amount: u64,
    pub borrow_value: u64,
    pub borrow_spot_market_index: u16,
    pub borrow_oracle_price: i64,
    pub deposit_spot_market_index: u16,
    pub deposit_oracle_price: i64,
    pub vault_equity: u64,
}

#[event]
pub struct ManagerRepayRecord {
    pub ts: i64,
    pub vault: Pubkey,
    pub manager: Pubkey,
    pub repay_amount: u64,
    pub repay_value: u64,
    pub repay_spot_market_index: u16,
    pub repay_oracle_price: i64,
    pub deposit_spot_market_index: u16,
    pub deposit_oracle_price: i64,
    pub vault_equity_before: u64,
    pub vault_equity_after: u64,
}

#[event]
pub struct ManagerUpdateBorrowRecord {
    pub ts: i64,
    pub vault: Pubkey,
    pub manager: Pubkey,
    pub previous_borrow_value: u64,
    pub new_borrow_value: u64,
    pub vault_equity_before: u64,
    pub vault_equity_after: u64,
}
