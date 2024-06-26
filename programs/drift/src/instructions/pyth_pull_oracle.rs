use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::{
    cpi::accounts::{
        PostUpdate,
        PostUpdateAtomic
    }, price_update::PriceUpdateV2, program::PythSolanaReceiver, PostUpdateAtomicParams, PostUpdateParams,
};
use pythnet_sdk::{
    messages::{
        FeedId,
        Message,
    }, wire::{from_slice, PrefixedVec}
};
use crate::error::ErrorCode;
use crate::ids::{
    wormhole_program,
    pyth_pull_program
};

pub const PTYH_PRICE_FEED_SEED_PREFIX: &[u8] = b"pyth_pull_prefix";

pub fn handle_update_price_feed(
    ctx: Context<UpdatePriceFeed>,
    params: PostUpdateParams,
    feed_id: FeedId,
) -> Result<()> {
    let cpi_program = ctx.accounts.pyth_solana_receiver.to_account_info().clone();
    let cpi_accounts = PostUpdate {
        payer:                ctx.accounts.keeper.to_account_info().clone(),
        encoded_vaa:          ctx.accounts.encoded_vaa.to_account_info().clone(),
        price_update_account: ctx.accounts.price_feed.to_account_info().clone(),
        write_authority:      ctx.accounts.price_feed.to_account_info().clone(),
    };

    let seeds = &[
        PTYH_PRICE_FEED_SEED_PREFIX,
        feed_id.as_ref(),
        &[ctx.bumps.price_feed],
    ];
    let signer_seeds = &[&seeds[..]];
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

    // Get the timestamp of the price currently stored in the price feed account.
    let current_timestamp = get_timestamp_from_price_feed_account(&ctx.accounts.price_feed)?;
    let next_timestamp = get_timestamp_from_price_update_message(&params.merkle_price_update.message)?;

    // Only update the price feed if the message contains a newer price. Pushing a stale price
    // suceeds without changing the on-chain state.
    if next_timestamp > current_timestamp {
        {
            let price_feed_account_data = ctx.accounts.price_feed.try_borrow_data()?;
            let price_feed_account =
                PriceUpdateV2::try_deserialize(&mut &price_feed_account_data[..])?;

            require!(
                price_feed_account.price_message.feed_id == feed_id,
                ErrorCode::OraclePriceFeedMessageMismatch
            );
        }
        pyth_solana_receiver_sdk::cpi::post_update(cpi_context, params)?;
    }
    Ok(())
}

pub fn handle_post_update_atomic(
    ctx: Context<PostUpdateAtomicInfo>,
    params: PostUpdateAtomicParams,
    feed_id: FeedId,
) -> Result<()> {
    let cpi_program = ctx.accounts.pyth_solana_receiver.to_account_info().clone();
    let cpi_accounts = PostUpdateAtomic {
        payer:                ctx.accounts.keeper.to_account_info().clone(),
        guardian_set:         ctx.accounts.guardian_set.to_account_info().clone(),
        price_update_account: ctx.accounts.price_feed.to_account_info().clone(),
        write_authority:      ctx.accounts.price_feed.to_account_info().clone(),
    };

    let seeds = &[
        PTYH_PRICE_FEED_SEED_PREFIX,
        feed_id.as_ref(),
        &[ctx.bumps.price_feed],
    ];
    let signer_seeds = &[&seeds[..]];
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

    // Get the timestamp of the price currently stored in the price feed account.
    let current_timestamp = get_timestamp_from_price_feed_account(&ctx.accounts.price_feed)?;
    let next_timestamp = get_timestamp_from_price_update_message(&params.merkle_price_update.message)?;

    if next_timestamp > current_timestamp {
        {
            let price_feed_account_data = ctx.accounts.price_feed.try_borrow_data()?;
            let price_feed_account =
                PriceUpdateV2::try_deserialize(&mut &price_feed_account_data[..])?;

            require!(
                price_feed_account.price_message.feed_id == feed_id,
                ErrorCode::OraclePriceFeedMessageMismatch
            );
        }
        pyth_solana_receiver_sdk::cpi::post_update_atomic(cpi_context, params)?;
    }
    Ok(())
}

pub fn get_timestamp_from_price_feed_account(
    price_feed_account: &AccountInfo
) -> Result<i64> {
    if price_feed_account.data_is_empty() {
        Ok(0)
    } else {
        let price_feed_account_data = price_feed_account.try_borrow_data()?;
        let price_feed_account =
            PriceUpdateV2::try_deserialize(&mut &price_feed_account_data[..])?;
        Ok(price_feed_account.price_message.publish_time)
    }
}

pub fn get_timestamp_from_price_update_message(
    update_message: &PrefixedVec<u16, u8>
) -> Result<i64> {
    let message =
        from_slice::<byteorder::BE, Message>(update_message.as_ref())
            .map_err(|_| ErrorCode::OracleDeserializeMessageFailed)?;
    let next_timestamp = match message {
        Message::PriceFeedMessage(price_feed_message) => price_feed_message.publish_time,
        Message::TwapMessage(_) => {
            return Err(ErrorCode::OracleUnsupportedMessageType.into());
        }
    };
    Ok(next_timestamp)
}

#[derive(Accounts)]
#[instruction(params : PostUpdateParams, feed_id : FeedId)]
pub struct UpdatePriceFeed<'info> {
    #[account(mut)]
    pub keeper:                Signer<'info>,
    pub pyth_solana_receiver: Program<'info, PythSolanaReceiver>,
    /// CHECK: Checked by CPI into the Pyth Solana Receiver
    #[account(owner = wormhole_program::id() @ ErrorCode::OracleWrongVaaOwner)]
    pub encoded_vaa:          AccountInfo<'info>,
    /// CHECK: This account's seeds are checked
    #[account(mut, seeds = [PTYH_PRICE_FEED_SEED_PREFIX, &feed_id], bump)]
    pub price_feed:   AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(params: PostUpdateAtomicParams, feed_id : FeedId)]
pub struct PostUpdateAtomicInfo <'info> {
    #[account(mut)]
    pub keeper:                Signer<'info>,
    pub pyth_solana_receiver: Program<'info, PythSolanaReceiver>,
    #[account(
        owner = wormhole_program::id() @ ErrorCode::OracleWrongGuardianSetOwner)]
    pub guardian_set:         AccountInfo<'info>,

    #[account(mut, owner = pyth_pull_program::id(), seeds = [PTYH_PRICE_FEED_SEED_PREFIX, &feed_id], bump)]
    pub price_feed: AccountInfo<'info>,
}
