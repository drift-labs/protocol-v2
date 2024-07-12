use crate::error::ErrorCode;
use crate::ids::{drift_oracle_receiver_program, wormhole_program};
use anchor_lang::prelude::*;
use byteorder::{BigEndian, ReadBytesExt};
use pyth_solana_receiver_sdk::{
    cpi::accounts::{PostUpdate, PostUpdateAtomic},
    price_update::PriceUpdateV2,
    program::PythSolanaReceiver,
    PostUpdateAtomicParams, PostUpdateParams,
};
use pythnet_sdk::accumulators::merkle::MerklePath;
use pythnet_sdk::wire::v1::MerklePriceUpdate;
use pythnet_sdk::{
    messages::Message,
    wire::{from_slice, PrefixedVec},
};
use std::io::{Cursor, Read};

pub const PTYH_PRICE_FEED_SEED_PREFIX: &[u8] = b"pyth_pull";
const KECCAK160_HASH_SIZE: usize = 20;

pub struct AccumulatorUpdateData {
    pub vaa: Vec<u8>,
    pub updates: Vec<Update>,
}

#[derive(Debug, AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Update {
    pub message: Vec<u8>,
    pub proof: Vec<Vec<u8>>,
}

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

pub fn handle_post_multi_pyth_pull_oracle_updates_atomic(
    ctx: Context<PostPythPullOracleUpdateAtomic>,
    feed_ids: Vec<[u8; 32]>,
    encoded_vaa: Vec<u8>,
) -> Result<()> {
    let price_updates = parse_accumulator_update_data(&encoded_vaa)?.updates;

    require!(
        feed_ids.len() == price_updates.len(),
        ErrorCode::OracleMismatchFeedIdAndParamAndPriceFeedAccountCount
    );

    let mut price_feeds = vec![&ctx.accounts.price_feed];
    if let Some(feed) = ctx.accounts.price_feed_1.as_ref() {
        price_feeds.push(feed);
    }
    if let Some(feed) = ctx.accounts.price_feed_2.as_ref() {
        price_feeds.push(feed);
    }

    require!(
        feed_ids.len() == price_feeds.len(),
        ErrorCode::OracleMismatchFeedIdAndParamAndPriceFeedAccountCount
    );

    for (i, feed_id) in feed_ids.iter().enumerate() {
        let cpi_program = ctx.accounts.pyth_solana_receiver.to_account_info().clone();
        let cpi_accounts = PostUpdateAtomic {
            payer: ctx.accounts.keeper.to_account_info().clone(),
            guardian_set: ctx.accounts.guardian_set.to_account_info().clone(),
            price_update_account: price_feeds[i].to_account_info().clone(),
            write_authority: price_feeds[i].to_account_info().clone(),
        };
        let bump: u8 = match i {
            0 => ctx.bumps.price_feed,
            1 => ctx.bumps.price_feed_1,
            2 => ctx.bumps.price_feed_2,
            _ => panic!("Invalid bumps index: {}", i),
        };

        let decoded_params = PostUpdateAtomicParams {
            vaa: encoded_vaa.clone(),
            merkle_price_update: update_to_merkle_price_update(price_updates[i].clone())?,
        };

        invoke_post_update_atomic_cpi(
            *feed_id,
            bump,
            cpi_program,
            cpi_accounts,
            price_feeds[i],
            None,
            Some(&decoded_params),
        )
        .unwrap();
    }

    Ok(())
}

pub fn handle_post_pyth_pull_oracle_update_atomic(
    ctx: Context<PostPythPullOracleUpdateAtomic>,
    feed_ids: Vec<[u8; 32]>,
    params: Vec<u8>,
) -> Result<()> {
    let cpi_program = ctx.accounts.pyth_solana_receiver.to_account_info().clone();
    let cpi_accounts = PostUpdateAtomic {
        payer: ctx.accounts.keeper.to_account_info().clone(),
        guardian_set: ctx.accounts.guardian_set.to_account_info().clone(),
        price_update_account: ctx.accounts.price_feed.to_account_info().clone(),
        write_authority: ctx.accounts.price_feed.to_account_info().clone(),
    };
    invoke_post_update_atomic_cpi(
        feed_ids[0],
        ctx.bumps.price_feed,
        cpi_program,
        cpi_accounts,
        &ctx.accounts.price_feed,
        Some(&params),
        None,
    )
    .unwrap();
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

pub fn invoke_post_update_atomic_cpi<'info>(
    feed_id: [u8; 32],
    bump: u8,
    cpi_program: AccountInfo<'info>,
    cpi_accounts: PostUpdateAtomic<'info>,
    price_feed: &AccountInfo<'info>,
    encoded_params: Option<&Vec<u8>>,
    decoded_params: Option<&PostUpdateAtomicParams>,
) -> Result<()> {
    let seeds = &[PTYH_PRICE_FEED_SEED_PREFIX, feed_id.as_ref(), &[bump]];
    let signer_seeds = &[&seeds[..]];
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
    let params = if Option::is_some(&encoded_params) {
        PostUpdateAtomicParams::deserialize(&mut &encoded_params.unwrap()[..]).unwrap()
    } else {
        decoded_params.unwrap().clone()
    };

    // Get the timestamp of the price currently stored in the price feed account.
    let current_timestamp = get_timestamp_from_price_feed_account(price_feed)?;
    let next_timestamp =
        get_timestamp_from_price_update_message(&params.merkle_price_update.message)?;

    // Only update the price feed if the message contains a newer price. Pushing a stale price
    // succeeds without changing the on-chain state.
    if next_timestamp > current_timestamp {
        pyth_solana_receiver_sdk::cpi::post_update_atomic(cpi_context, params)?;
        {
            let price_feed_account_data = price_feed.try_borrow_data()?;
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

pub fn parse_accumulator_update_data(data: &[u8]) -> Result<AccumulatorUpdateData> {
    let mut cursor = Cursor::new(data);
    cursor.set_position(6);

    let trailing_payload_size = cursor.read_u8().unwrap();
    cursor.set_position(cursor.position() + u64::from(trailing_payload_size));

    // let proof_type = cursor.read_u8().unwrap();
    cursor.set_position(cursor.position() + 1);

    let vaa_size = cursor.read_u16::<BigEndian>().unwrap();
    let mut vaa = vec![0; vaa_size as usize];
    cursor.read_exact(&mut vaa).unwrap();

    let num_updates = cursor.read_u8().unwrap();
    let mut updates = Vec::with_capacity(num_updates as usize);

    for _ in 0..num_updates {
        let message_size = cursor.read_u16::<BigEndian>().unwrap();
        let mut message = vec![0; message_size as usize];
        cursor.read_exact(&mut message).unwrap();

        let num_proofs = cursor.read_u8().unwrap();
        let mut proof = Vec::with_capacity(num_proofs as usize);

        for _ in 0..num_proofs {
            let mut proof_data = vec![0; KECCAK160_HASH_SIZE];
            cursor.read_exact(&mut proof_data).unwrap();
            proof.push(proof_data);
        }

        updates.push(Update { message, proof });
    }

    if cursor.position() != data.len() as u64 {
        return Err(ErrorCode::OracleParseAccumulatorDataFailed.into());
    }

    Ok(AccumulatorUpdateData { vaa, updates })
}

fn convert_to_keccak160(data: Vec<u8>) -> Result<[u8; 20]> {
    if data.len() != 20 {
        panic!("Invalid proof element size: {}", data.len());
    }
    let mut array = [0u8; 20];
    array.copy_from_slice(&data);
    Ok(array)
}

fn update_to_merkle_price_update(update: Update) -> Result<MerklePriceUpdate> {
    let proof: Result<Vec<[u8; 20]>> = update.proof.into_iter().map(convert_to_keccak160).collect();

    let proof = MerklePath::new(proof?);

    Ok(MerklePriceUpdate {
        message: update.message.into(),
        proof,
    })
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
#[instruction(feed_ids : Vec<[u8; 32]>)]
pub struct PostPythPullOracleUpdateAtomic<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    pub pyth_solana_receiver: Program<'info, PythSolanaReceiver>,
    /// CHECK: We can't use AccountVariant::<GuardianSet> here because its owner is hardcoded as the "official" Wormhole program
    #[account(
        owner = wormhole_program::id() @ ErrorCode::OracleWrongGuardianSetOwner)]
    pub guardian_set: AccountInfo<'info>,

    /// CHECK: This account's seeds are checked
    #[account(mut, owner = drift_oracle_receiver_program::id(), seeds = [PTYH_PRICE_FEED_SEED_PREFIX, &feed_ids[0]], bump)]
    pub price_feed: AccountInfo<'info>,

    /// CHECK: This account's seeds are checked
    #[account(mut, owner = drift_oracle_receiver_program::id(), seeds = [PTYH_PRICE_FEED_SEED_PREFIX, &feed_ids[1]], bump)]
    pub price_feed_1: Option<AccountInfo<'info>>,

    /// CHECK: This account's seeds are checked
    #[account(mut, owner = drift_oracle_receiver_program::id(), seeds = [PTYH_PRICE_FEED_SEED_PREFIX, &feed_ids[2]], bump)]
    pub price_feed_2: Option<AccountInfo<'info>>,
}
