use std::cell::RefMut;

use anchor_lang::prelude::*;
use bytemuck::{cast_slice_mut, from_bytes_mut, try_cast_slice_mut};
use {
    anchor_lang::prelude::borsh::BorshSchema,
    bytemuck::{Pod, Zeroable},
    solana_program::pubkey::Pubkey,
};

declare_id!("G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha");

#[program]
pub mod pyth_pull {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, price: i64, expo: i32, conf: u64) -> Result<()> {
        let price_update = &ctx.accounts.price_update;
        let mut price_oracle = PriceUpdateV2::load(price_update).unwrap();

        let price_message = PriceFeedMessage {
            feed_id: [0; 32],
            price,
            conf,
            exponent: expo,
            publish_time: 0,
            prev_publish_time: 0,
            ema_price: 0,
            ema_conf: 0,
        };
        price_oracle.posted_slot = 2712847316;
        price_oracle.price_message = price_message;
        price_oracle.verification_level = VerificationLevel::Partial { num_signatures: 2 };
        price_oracle.write_authority = Pubkey::new_unique();
        Ok(())
    }

    pub fn set_price(ctx: Context<SetPrice>, price: i64) -> Result<()> {
        let price_update = &ctx.accounts.price_update;
        let mut price_oracle = PriceUpdateV2::load(price_update).unwrap();

        price_oracle.price_message.ema_price = price_oracle
            .price_message
            .ema_price
            .checked_add(price)
            .unwrap()
            .checked_div(2)
            .unwrap(); //todo
        price_oracle.price_message.price = price;
        Ok(())
    }

    pub fn set_price_info(ctx: Context<SetPrice>, price: i64, conf: u64, slot: u64) -> Result<()> {
        let price_update = &ctx.accounts.price_update;
        let mut price_oracle = PriceUpdateV2::load(price_update).unwrap();

        price_oracle.price_message.ema_price = price_oracle
            .price_message
            .ema_price
            .checked_add(price)
            .unwrap()
            .checked_div(2)
            .unwrap(); //todo
        price_oracle.price_message.price = price;
        price_oracle.price_message.conf = conf;
        price_oracle.posted_slot = slot;

        Ok(())
    }

    pub fn set_twap(ctx: Context<SetPrice>, twap: i64) -> Result<()> {
        let price_update = &ctx.accounts.price_update;
        let mut price_oracle = PriceUpdateV2::load(price_update).unwrap();

        price_oracle.price_message.ema_price = twap;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, BorshSchema, Debug)]
pub enum VerificationLevel {
    Partial { num_signatures: u8 },
    Full,
}

#[derive(BorshSchema, Copy, Clone)]
pub struct PriceUpdateV2 {
    pub write_authority: Pubkey,
    pub verification_level: VerificationLevel,
    pub price_message: PriceFeedMessage,
    pub posted_slot: u64,
}

impl PriceUpdateV2 {
    pub const LEN: usize = 8 + 32 + 2 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8;

    #[inline]
    pub fn load<'a>(
        price_feed: &'a AccountInfo,
    ) -> std::result::Result<RefMut<'a, PriceUpdateV2>, ProgramError> {
        let account_data: RefMut<'a, [u8]> =
            RefMut::map(price_feed.try_borrow_mut_data().unwrap(), |data| *data);

        let state: RefMut<'a, Self> = RefMut::map(account_data, |data| {
            from_bytes_mut(cast_slice_mut::<u8, u8>(try_cast_slice_mut(data).unwrap()))
        });
        Ok(state)
    }
}

#[derive(PartialEq, Debug, Clone, Copy)]
pub struct Price {
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

pub type FeedId = [u8; 32];

#[repr(C)]
#[derive(Debug, Copy, Clone, PartialEq, BorshSchema, AnchorSerialize, AnchorDeserialize)]
pub struct PriceFeedMessage {
    pub feed_id: FeedId,
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
    pub prev_publish_time: i64,
    pub ema_price: i64,
    pub ema_conf: u64,
}

unsafe impl Pod for PriceUpdateV2 {}
unsafe impl Zeroable for PriceUpdateV2 {}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    /// CHECK: this program is just for testing
    #[account(mut)]
    pub price_update: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// CHECK: this program is just for testing
    #[account(mut)]
    pub price_update: AccountInfo<'info>,
}
