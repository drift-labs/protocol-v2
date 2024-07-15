use anchor_lang::prelude::*;
pub mod pc;
use pc::Price;

#[cfg(feature = "mainnet-beta")]
declare_id!("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s");

#[program]
pub mod pyth {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, price: i64, expo: i32, conf: u64) -> Result<()> {
        let oracle = &ctx.accounts.price;

        let mut price_oracle = Price::load(oracle).unwrap();

        price_oracle.magic = 2712847316;
        price_oracle.agg.price = price;
        price_oracle.agg.conf = conf;
        price_oracle.agg.conf = 0;
        price_oracle.valid_slot = 228506959; //todo just turned 1->2 for negative delay
        price_oracle.ver = 2;
        price_oracle.atype = 3;
        price_oracle.size = 3216;

        price_oracle.twap = price;
        price_oracle.expo = expo;
        price_oracle.ptype = pc::PriceType::Price;
        Ok(())
    }

    pub fn set_price(ctx: Context<SetPrice>, price: i64) -> Result<()> {
        let oracle = &ctx.accounts.price;
        let mut price_oracle = Price::load(oracle).unwrap();

        price_oracle.twap = price_oracle
            .twap
            .checked_add(price)
            .unwrap()
            .checked_div(2)
            .unwrap(); //todo
        price_oracle.agg.price = price;
        Ok(())
    }

    pub fn set_price_info(ctx: Context<SetPrice>, price: i64, conf: u64, slot: u64) -> Result<()> {
        let oracle = &ctx.accounts.price;
        let mut price_oracle = Price::load(oracle).unwrap();

        price_oracle.twap = price_oracle
            .twap
            .checked_add(price)
            .unwrap()
            .checked_div(2)
            .unwrap(); //todo
        price_oracle.agg.price = price;
        price_oracle.agg.conf = conf;
        price_oracle.valid_slot = slot;

        Ok(())
    }

    pub fn set_twap(ctx: Context<SetPrice>, twap: i64) -> Result<()> {
        let oracle = &ctx.accounts.price;
        let mut price_oracle = Price::load(oracle).unwrap();

        price_oracle.twap = twap;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    /// CHECK: this program is just for testing
    #[account(mut)]
    pub price: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// CHECK: this program is just for testing
    #[account(mut)]
    pub price: AccountInfo<'info>,
}
