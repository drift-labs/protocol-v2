use anchor_lang::prelude::*;
mod pc;
use pc::Price;

#[cfg(feature = "mainnet-beta")]
declare_id!("8p6JBuvpnBKDKuFx822mNrLFVspnvKViQtsBDoeys7ST");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("7HjaJjhsDvQfqqZSzztWZ2jQdjwjudAPygxm296MLZtR");

#[program]
pub mod pyth {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        price: i64,
        expo: i32,
        _conf: u64,
    ) -> ProgramResult {
        let oracle = &ctx.accounts.price;

        let mut price_oracle = Price::load(&oracle).unwrap();

        price_oracle.agg.price = price;
        price_oracle.agg.conf = 0;

        price_oracle.twap = price;
        price_oracle.expo = expo;
        price_oracle.ptype = pc::PriceType::Price;
        Ok(())
    }

    pub fn set_price(ctx: Context<SetPrice>, price: i64) -> ProgramResult {
        let oracle = &ctx.accounts.price;
        let mut price_oracle = Price::load(&oracle).unwrap();

        price_oracle.twap = price_oracle
            .twap
            .checked_add(price)
            .unwrap()
            .checked_div(2)
            .unwrap(); //todo
        price_oracle.agg.price = price as i64;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    #[account(mut)]
    pub price: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub price: AccountInfo<'info>,
}
