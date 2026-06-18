use anchor_lang::prelude::*;

pub trait InitializeUserCPI {
    fn drift_initialize_user(&self, name: [u8; 32], bump: u8) -> Result<()>;

    fn drift_initialize_user_stats(&self, name: [u8; 32], bump: u8) -> Result<()>;
}

pub trait DepositCPI {
    fn drift_deposit(&self, amount: u64) -> Result<()>;
}

pub trait ManagerRepayCPI {
    fn drift_deposit(&self, market_index: u16, amount: u64) -> Result<()>;
}

pub trait WithdrawCPI {
    fn drift_withdraw(&self, amount: u64) -> Result<()>;
}

pub trait ManagerBorrowCPI {
    fn drift_withdraw(&self, market_index: u16, amount: u64) -> Result<()>;
}

pub trait UpdateUserDelegateCPI {
    fn drift_update_user_delegate(&self, delegate: Pubkey) -> Result<()>;
}

pub trait UpdateUserReduceOnlyCPI {
    fn drift_update_user_reduce_only(&self, reduce_only: bool) -> Result<()>;
}

pub trait UpdateUserMarginTradingEnabledCPI {
    fn drift_update_user_margin_trading_enabled(&self, enabled: bool) -> Result<()>;
}

pub trait UpdatePoolIdCPI {
    fn drift_update_pool_id(&self, pool_id: u8) -> Result<()>;
}

pub trait InitializeInsuranceFundStakeCPI {
    fn drift_initialize_insurance_fund_stake(&self, market_index: u16) -> Result<()>;
}

pub trait AddInsuranceFundStakeCPI {
    fn drift_add_insurance_fund_stake(&self, market_index: u16, amount: u64) -> Result<()>;
}

pub trait RequestRemoveInsuranceFundStakeCPI {
    fn drift_request_remove_insurance_fund_stake(
        &self,
        market_index: u16,
        amount: u64,
    ) -> Result<()>;
}

pub trait CancelRequestRemoveInsuranceFundStakeCPI {
    fn drift_cancel_request_remove_insurance_fund_stake(&self, market_index: u16) -> Result<()>;
}
pub trait RemoveInsuranceFundStakeCPI {
    fn drift_remove_insurance_fund_stake(&self, market_index: u16) -> Result<()>;
}
