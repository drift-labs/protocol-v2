use anchor_lang::prelude::*;

pub trait InitializeUserCPI {
    fn velocity_initialize_user(&self, name: [u8; 32], bump: u8) -> Result<()>;

    fn velocity_initialize_user_stats(&self, name: [u8; 32], bump: u8) -> Result<()>;
}

pub trait DepositCPI {
    fn velocity_deposit(&self, amount: u64) -> Result<()>;
}

pub trait ManagerRepayCPI {
    fn velocity_deposit(&self, market_index: u16, amount: u64) -> Result<()>;
}

pub trait WithdrawCPI {
    fn velocity_withdraw(&self, amount: u64) -> Result<()>;
}

pub trait ManagerBorrowCPI {
    fn velocity_withdraw(&self, market_index: u16, amount: u64) -> Result<()>;
}

pub trait UpdateUserDelegateCPI {
    fn velocity_update_user_delegate(&self, delegate: Pubkey) -> Result<()>;
}

pub trait UpdateUserReduceOnlyCPI {
    fn velocity_update_user_reduce_only(&self, reduce_only: bool) -> Result<()>;
}

pub trait UpdateUserMarginTradingEnabledCPI {
    fn velocity_update_user_margin_trading_enabled(&self, enabled: bool) -> Result<()>;
}

pub trait UpdatePoolIdCPI {
    fn velocity_update_pool_id(&self, pool_id: u8) -> Result<()>;
}

pub trait InitializeInsuranceFundStakeCPI {
    fn velocity_initialize_insurance_fund_stake(&self, market_index: u16) -> Result<()>;
}

pub trait AddInsuranceFundStakeCPI {
    fn velocity_add_insurance_fund_stake(&self, market_index: u16, amount: u64) -> Result<()>;
}

pub trait RequestRemoveInsuranceFundStakeCPI {
    fn velocity_request_remove_insurance_fund_stake(
        &self,
        market_index: u16,
        amount: u64,
    ) -> Result<()>;
}

pub trait CancelRequestRemoveInsuranceFundStakeCPI {
    fn velocity_cancel_request_remove_insurance_fund_stake(&self, market_index: u16) -> Result<()>;
}
pub trait RemoveInsuranceFundStakeCPI {
    fn velocity_remove_insurance_fund_stake(&self, market_index: u16) -> Result<()>;
}
