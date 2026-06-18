use anchor_lang::prelude::*;

pub trait MintTokensCPI {
    fn mint(&self, vault_name: [u8; 32], vault_bump: u8, amount: u64) -> Result<()>;
}

pub trait BurnTokensCPI {
    fn burn(&self, vault_name: [u8; 32], vault_bump: u8, amount: u64) -> Result<()>;
}

pub trait TokenTransferCPI {
    fn token_transfer(&self, amount: u64) -> Result<()>;
}
