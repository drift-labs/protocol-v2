use crate::error::ErrorCode;
use anchor_lang::prelude::*;
use pyth_lazer::{PythLazerOracle, PYTH_LAZER_ORACLE_SEED, PYTH_LAZER_STORAGE_ID};
use pyth_lazer_sdk::protocol::payload::{PayloadData, PayloadPropertyValue};

pub fn handle_update_pyth_lazer_oracle(
    ctx: Context<UpdatePythLazerOracle>,
    feed_id: u16,
    pyth_message: Vec<u8>,
) -> Result<()> {
    let verified = pyth_lazer_sdk::verify_message(
        &ctx.accounts.pyth_lazer_storage,
        &ctx.accounts.system_program.to_account_info(),
        &pyth_message,
        0,
        0,
        0,
    );
    if verified.is_err() {
        return Err(ErrorCode::UnverifiedPythLazerMessage.into());
    }

    let data = PayloadData::deserialize_slice_le(verified.unwrap().payload)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    if data.feeds.is_empty() || data.feeds[0].properties.is_empty() {
        return Err(ErrorCode::InvalidPythLazerMessage.into());
    }

    if data.channel_id.0 as u16 != feed_id {
        return Err(ErrorCode::InvalidPythLazerMessage.into());
    }

    let mut pyth_lazer_oracle = ctx.accounts.pyth_lazer_oracle.load_mut()?;
    let current_timestamp = pyth_lazer_oracle.publish_time;
    let next_timestamp = data.timestamp_us.0;

    if next_timestamp > current_timestamp {
        let PayloadPropertyValue::Price(Some(price)) = data.feeds[0].properties[0] else {
            return Err(ErrorCode::InvalidPythLazerMessage.into());
        };
        pyth_lazer_oracle.price = price.0.get();
        pyth_lazer_oracle.posted_slot = Clock::get()?.slot;
        pyth_lazer_oracle.publish_time = next_timestamp;
        pyth_lazer_oracle.conf = 0;
        pyth_lazer_oracle.exponent = -8;
        msg!(
            "Posting new lazer update. current ts {} < next ts {}",
            current_timestamp,
            next_timestamp
        );
    } else {
        msg!(
            "Skipping new lazer update. current ts {} >= next ts {}",
            current_timestamp,
            next_timestamp
        );
    }

    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: u16)]
pub struct UpdatePythLazerOracle<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
      mut,
      address = PYTH_LAZER_STORAGE_ID @ ErrorCode::InvalidPythLazerStorageOwner
    )]
    pub pyth_lazer_storage: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    #[account(mut, seeds = [PYTH_LAZER_ORACLE_SEED, &feed_id.to_le_bytes()], bump)]
    pub pyth_lazer_oracle: AccountLoader<'info, PythLazerOracle>,
}
