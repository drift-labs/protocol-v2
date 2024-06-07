use crate::*;

#[derive(Accounts)]
pub struct PlaceTakeOrder<'info> {
    pub dummy_authority: Signer<'info>,
}