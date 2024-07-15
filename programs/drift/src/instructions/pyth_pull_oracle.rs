use crate::error::ErrorCode;
use crate::ids::{drift_oracle_receiver_program, wormhole_program};
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::{
    cpi::accounts::{PostUpdate, PostUpdateAtomic},
    price_update::PriceUpdateV2,
    program::PythSolanaReceiver,
    PostMultiUpdatesAtomicParams, PostUpdateAtomicParams, PostUpdateParams,
};
use pythnet_sdk::{
    messages::Message,
    wire::{from_slice, PrefixedVec},
};

pub const PTYH_PRICE_FEED_SEED_PREFIX: &[u8] = b"pyth_pull";

pub fn handle_update_pyth_pull_oracle(
    ctx: Context<UpdatePythPullOraclePriceFeed>,
    feed_id: [u8; 32],
    params: Vec<u8>,
) -> Result<()> {
    let cpi_program = ctx.accounts.pyth_solana_receiver.to_account_info().clone();
    let cpi_accounts = PostUpdate {
        payer: ctx.accounts.keeper.to_account_info().clone(),
        encoded_vaa: ctx.accounts.encoded_vaa.to_account_info().clone(),
        price_update_account: ctx.accounts.price_feed.to_account_info().clone(),
        write_authority: ctx.accounts.price_feed.to_account_info().clone(),
    };

    let seeds = &[
        PTYH_PRICE_FEED_SEED_PREFIX,
        feed_id.as_ref(),
        &[ctx.bumps.price_feed],
    ];
    let signer_seeds = &[&seeds[..]];
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

    let params = PostUpdateParams::deserialize(&mut &params[..]).unwrap();

    // Get the timestamp of the price currently stored in the price feed account.
    let current_timestamp = get_timestamp_from_price_feed_account(&ctx.accounts.price_feed)?;
    let next_timestamp =
        get_timestamp_from_price_update_message(&params.merkle_price_update.message)?;

    // Only update the price feed if the message contains a newer price. Pushing a stale price
    // suceeds without changing the on-chain state.
    if next_timestamp > current_timestamp {
        pyth_solana_receiver_sdk::cpi::post_update(cpi_context, params)?;
        {
            let price_feed_account_data = ctx.accounts.price_feed.try_borrow_data()?;
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

pub fn handle_post_pyth_pull_oracle_update_atomic(
    ctx: Context<PostPythPullOracleUpdateAtomic>,
    feed_id: [u8; 32],
    params: Vec<u8>,
) -> Result<()> {
    let cpi_program = ctx.accounts.pyth_solana_receiver.to_account_info().clone();
    let cpi_accounts = PostUpdateAtomic {
        payer: ctx.accounts.keeper.to_account_info().clone(),
        guardian_set: ctx.accounts.guardian_set.to_account_info().clone(),
        price_update_account: ctx.accounts.price_feed.to_account_info().clone(),
        write_authority: ctx.accounts.price_feed.to_account_info().clone(),
    };

    let seeds = &[
        PTYH_PRICE_FEED_SEED_PREFIX,
        feed_id.as_ref(),
        &[ctx.bumps.price_feed],
    ];
    let signer_seeds = &[&seeds[..]];
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

    let params = PostUpdateAtomicParams::deserialize(&mut &params[..]).unwrap();

    // Get the timestamp of the price currently stored in the price feed account.
    let current_timestamp = get_timestamp_from_price_feed_account(&ctx.accounts.price_feed)?;
    let next_timestamp =
        get_timestamp_from_price_update_message(&params.merkle_price_update.message)?;

    if next_timestamp > current_timestamp {
        pyth_solana_receiver_sdk::cpi::post_update_atomic(cpi_context, params)?;

        {
            let price_feed_account_data = ctx.accounts.price_feed.try_borrow_data()?;
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

pub fn handle_post_multi_pyth_pull_oracle_updates_atomic<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, PostPythPullMultiOracleUpdatesAtomic<'info>>,
    params: Vec<u8>,
) -> Result<()> {
    let remaining_accounts = ctx.remaining_accounts;
    require!(
        remaining_accounts.len() <= 2,
        ErrorCode::OracleTooManyPriceAccountUpdates
    );
    let update_param = PostMultiUpdatesAtomicParams::deserialize(&mut &params[..]).unwrap();
    let vaa = update_param.vaa;
    let merkle_price_updates = update_param.merkle_price_updates;

    require!(
        remaining_accounts.len() == merkle_price_updates.len(),
        ErrorCode::OracleMismatchedVaaAndPriceUpdates
    );

    for (account, merkle_price_update) in remaining_accounts.iter().zip(merkle_price_updates.iter())
    {
        let cpi_program = ctx.accounts.pyth_solana_receiver.to_account_info().clone();
        let cpi_accounts = PostUpdateAtomic {
            payer: ctx.accounts.keeper.to_account_info().clone(),
            guardian_set: ctx.accounts.guardian_set.to_account_info().clone(),
            price_update_account: account.clone(),
            write_authority: account.clone(),
        };

        let price_feed_account_data = account.try_borrow_data()?;
        let price_feed_account = PriceUpdateV2::try_deserialize(&mut &price_feed_account_data[..])?;
        let feed_id = price_feed_account.price_message.feed_id;

        // Verify the pda
        let (pda, bump) = Pubkey::find_program_address(
            &[PTYH_PRICE_FEED_SEED_PREFIX, feed_id.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(
            *account.key,
            pda,
            ErrorCode::OracleBadRemainingAccountPublicKey
        );

        let seeds = &[PTYH_PRICE_FEED_SEED_PREFIX, feed_id.as_ref(), &[bump]];

        let signer_seeds = &[&seeds[..]];
        let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Get the timestamp of the price currently stored in the price feed account.
        let current_timestamp = get_timestamp_from_price_feed_account(account)?;
        let next_timestamp = get_timestamp_from_price_update_message(&merkle_price_update.message)?;

        if next_timestamp > current_timestamp {
            pyth_solana_receiver_sdk::cpi::post_update_atomic(
                cpi_context,
                PostUpdateAtomicParams {
                    merkle_price_update: merkle_price_update.clone(),
                    vaa: vaa.clone(),
                },
            )?;
            msg!("Price feed updated");
        }
    }

    Ok(())
}

pub fn get_timestamp_from_price_feed_account(price_feed_account: &AccountInfo) -> Result<i64> {
    if price_feed_account.data_is_empty() {
        Ok(0)
    } else {
        let price_feed_account_data = price_feed_account.try_borrow_data()?;
        let price_feed_account = PriceUpdateV2::try_deserialize(&mut &price_feed_account_data[..])?;
        Ok(price_feed_account.price_message.publish_time)
    }
}

pub fn get_timestamp_from_price_update_message(
    update_message: &PrefixedVec<u16, u8>,
) -> Result<i64> {
    let message = from_slice::<byteorder::BE, Message>(update_message.as_ref())
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
#[instruction(feed_id : [u8; 32])]
pub struct UpdatePythPullOraclePriceFeed<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    pub pyth_solana_receiver: Program<'info, PythSolanaReceiver>,
    /// CHECK: Checked by CPI into the Pyth Solana Receiver
    #[account(owner = wormhole_program::id() @ ErrorCode::OracleWrongVaaOwner)]
    pub encoded_vaa: AccountInfo<'info>,
    /// CHECK: This account's seeds are checked
    #[account(mut, seeds = [PTYH_PRICE_FEED_SEED_PREFIX, &feed_id], bump, owner = drift_oracle_receiver_program::id())]
    pub price_feed: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(feed_id : [u8; 32])]
pub struct PostPythPullOracleUpdateAtomic<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    pub pyth_solana_receiver: Program<'info, PythSolanaReceiver>,
    /// CHECK: We can't use AccountVariant::<GuardianSet> here because its owner is hardcoded as the "official" Wormhole program
    #[account(
        owner = wormhole_program::id() @ ErrorCode::OracleWrongGuardianSetOwner)]
    pub guardian_set: AccountInfo<'info>,

    /// CHECK: This account's seeds are checked
    #[account(mut, owner = drift_oracle_receiver_program::id(), seeds = [PTYH_PRICE_FEED_SEED_PREFIX, &feed_id], bump)]
    pub price_feed: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct PostPythPullMultiOracleUpdatesAtomic<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    pub pyth_solana_receiver: Program<'info, PythSolanaReceiver>,
    /// CHECK: We can't use AccountVariant::<GuardianSet> here because its owner is hardcoded as the "official" Wormhole program
    #[account(
        owner = wormhole_program::id() @ ErrorCode::OracleWrongGuardianSetOwner)]
    pub guardian_set: AccountInfo<'info>,
}
