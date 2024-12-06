use crate::error::ErrorCode;
use crate::state::pyth_lazer_oracle::{
    PythLazerOracle, PYTH_LAZER_ORACLE_SEED, PYTH_LAZER_STORAGE_ID,
};
use crate::validate;
use anchor_lang::prelude::*;
use pyth_lazer_sdk::protocol::payload::{PayloadData, PayloadPropertyValue};
use solana_program::sysvar::instructions::load_current_index_checked;

pub fn handle_update_pyth_lazer_oracle(
    ctx: Context<UpdatePythLazerOracle>,
    feed_id: u32,
    pyth_message: Vec<u8>,
) -> Result<()> {
    let ix_idx = load_current_index_checked(&ctx.accounts.ix_sysvar.to_account_info())?;
    validate!(
        ix_idx > 0,
        ErrorCode::InvalidVerificationIxIndex,
        "instruction index must be greater than 1 for two sig verifies"
    )?;

    let verified = pyth_lazer_sdk::verify_message(
        &ctx.accounts.pyth_lazer_storage,
        &ctx.accounts.ix_sysvar.to_account_info(),
        &pyth_message,
        ix_idx - 1,
        0,
        1,
    );
    if verified.is_err() {
        msg!("{:?}", verified);
        return Err(ErrorCode::UnverifiedPythLazerMessage.into());
    }

    let data = PayloadData::deserialize_slice_le(verified.unwrap().payload)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    if data.feeds.is_empty() || data.feeds[0].properties.is_empty() {
        return Err(ErrorCode::InvalidPythLazerMessage.into());
    }

    if data.feeds[0].feed_id.0 != feed_id {
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
        msg!("Price updated to {}", price.0.get());

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
#[instruction(feed_id: u32, pyth_message: Vec<u8>)]
pub struct UpdatePythLazerOracle<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    /// CHECK: Pyth lazer storage account not available to us
    #[account(
      mut,
      address = PYTH_LAZER_STORAGE_ID @ ErrorCode::InvalidPythLazerStorageOwner
    )]
    pub pyth_lazer_storage: AccountInfo<'info>,
    /// CHECK: checked by ed25519 verify
    #[account(address = solana_program::sysvar::instructions::ID)]
    pub ix_sysvar: AccountInfo<'info>,
    #[account(mut, seeds = [PYTH_LAZER_ORACLE_SEED, &feed_id.to_le_bytes()], bump)]
    pub pyth_lazer_oracle: AccountLoader<'info, PythLazerOracle>,
}
