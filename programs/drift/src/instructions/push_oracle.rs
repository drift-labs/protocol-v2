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
    },
    wire::from_slice,
};
use crate::error::ErrorCode;
use crate::ids::{
    wormhole_program,
    pyth_pull_program
};

pub fn handle_update_price_feed(
    ctx: Context<UpdatePriceFeed>,
    params: PostUpdateParams,
    shard_id: u16,
    feed_id: FeedId,
) -> Result<()> {
    let cpi_program = ctx.accounts.pyth_solana_receiver.to_account_info().clone();
    let cpi_accounts = PostUpdate {
        payer:                ctx.accounts.payer.to_account_info().clone(),
        encoded_vaa:          ctx.accounts.encoded_vaa.to_account_info().clone(),
        price_update_account: ctx.accounts.price_feed_account.to_account_info().clone(),
        write_authority:      ctx.accounts.price_feed_account.to_account_info().clone(),
    };

    let seeds = &[
        &shard_id.to_le_bytes(),
        feed_id.as_ref(),
        &[ctx.bumps.price_feed_account],
    ];
    let signer_seeds = &[&seeds[..]];
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

    // Get the timestamp of the price currently stored in the price feed account.
    let current_timestamp = {
        if ctx.accounts.price_feed_account.data_is_empty() {
            0
        } else {
            let price_feed_account_data = ctx.accounts.price_feed_account.try_borrow_data()?;
            let price_feed_account =
                PriceUpdateV2::try_deserialize(&mut &price_feed_account_data[..])?;
            price_feed_account.price_message.publish_time
        }
    };

    // Get the timestamp of the price in the arguments (that we are trying to put in the account).
    // It is a little annoying that we have to redundantly deserialize the message here, but
    // it is required to make txs pushing stale prices succeed w/o updating the on-chain price.
    //
    // Note that we don't do any validity checks on the proof etc. here. If the caller passes an
    // invalid message with a newer timestamp, the validity checks will be performed by pyth_solana_receiver.
    let message =
        from_slice::<byteorder::BE, Message>(params.merkle_price_update.message.as_ref())
            .map_err(|_| ErrorCode::OracleDeserializeMessageFailed)?;
    let next_timestamp = match message {
        Message::PriceFeedMessage(price_feed_message) => price_feed_message.publish_time,
        Message::TwapMessage(_) => {
            return err!(ErrorCode::OracleUnsupportedMessageType);
        }
    };

    // Only update the price feed if the message contains a newer price. Pushing a stale price
    // suceeds without changing the on-chain state.
    if next_timestamp > current_timestamp {
        pyth_solana_receiver_sdk::cpi::post_update(cpi_context, params)?;
        {
            let price_feed_account_data = ctx.accounts.price_feed_account.try_borrow_data()?;
            let price_feed_account =
                PriceUpdateV2::try_deserialize(&mut &price_feed_account_data[..])?;

            require!(
                price_feed_account.price_message.feed_id == feed_id,
                ErrorCode::OraclePriceFeedMessageMismatch
            );
        }
    }
    Ok(())
}

pub fn handle_post_update_atomic(
    ctx: Context<PostUpdateAtomicInfo>,
    params: PostUpdateAtomicParams,
    shard_id: u16,
    feed_id: FeedId,
) -> Result<()> {
    let cpi_program = ctx.accounts.pyth_solana_receiver.to_account_info().clone();
    let cpi_accounts = PostUpdateAtomic {
        payer:                ctx.accounts.payer.to_account_info().clone(),
        guardian_set:         ctx.accounts.guardian_set.to_account_info().clone(),
        price_update_account: ctx.accounts.price_feed_account.to_account_info().clone(),
        write_authority:      ctx.accounts.price_feed_account.to_account_info().clone(),
    };

    let seeds = &[
        &shard_id.to_le_bytes(),
        feed_id.as_ref(),
        &[ctx.bumps.price_feed_account],
    ];
    let signer_seeds = &[&seeds[..]];
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

    pyth_solana_receiver_sdk::cpi::post_update_atomic(cpi_context, params)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(params : PostUpdateParams, shard_id : u16, feed_id : FeedId)]
pub struct UpdatePriceFeed<'info> {
    #[account(mut)]
    pub payer:                Signer<'info>,
    pub pyth_solana_receiver: Program<'info, PythSolanaReceiver>,
    /// CHECK: Checked by CPI into the Pyth Solana Receiver
    /// 
    pub encoded_vaa:          AccountInfo<'info>,
    /// CHECK: This account's seeds are checked
    #[account(mut, seeds = [&shard_id.to_le_bytes(), &feed_id], bump)]
    pub price_feed_account:   AccountInfo<'info>,
    pub system_program:       Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: PostUpdateAtomicParams, shard_id : u16, feed_id : FeedId)]
pub struct PostUpdateAtomicInfo <'info> {
    #[account(mut)]
    pub payer:                Signer<'info>,
    pub pyth_solana_receiver: Program<'info, PythSolanaReceiver>,
    /// CHECK: We can't use AccountVariant::<GuardianSet> here because its owner is hardcoded as the "official" Wormhole program and we want to get the wormhole address from the config.
    /// Instead we do the same steps in deserialize_guardian_set_checked.
    #[account(
        owner = wormhole_program::id() @ ErrorCode::OracleWrongGuardianSetOwner)]
    pub guardian_set:         AccountInfo<'info>,

    /// The constraint is such that either the price_update_account is uninitialized or the write_authority is the write_authority.
    /// Pubkey::default() is the SystemProgram on Solana and it can't sign so it's impossible that price_update_account.write_authority == Pubkey::default() once the account is initialized
    #[account(mut, owner = pyth_pull_program::id(), seeds = [&shard_id.to_le_bytes(), &feed_id], bump)]
    pub price_feed_account: Account<'info, PriceUpdateV2>,
}
