use crate::*;

#[derive(Accounts)]
pub struct PlaceTakeOrder<'info> {
    pub dummy_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    pub dummy_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateOpenOrdersIndexer<'info> {
    pub dummy_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateOpenOrdersAccount<'info> {
    pub dummy_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub dummy_authority: Signer<'info>,
}