use crate::error::ErrorCode;
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;
use crate::state::pyth_lazer_oracle::{
    PythLazerOracle, PYTH_LAZER_ORACLE_SEED, PYTH_LAZER_STORAGE_ID,
};
use crate::validate;
use anchor_lang::prelude::*;
use pyth_lazer_sdk::protocol::payload::{PayloadData, PayloadPropertyValue};
use pyth_lazer_sdk::protocol::router::Price;
use solana_program::sysvar::instructions::load_current_index_checked;

pub fn handle_update_pyth_lazer_oracle<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdatePythLazerOracle>,
    pyth_message: Vec<u8>,
) -> Result<()> {
    // Verify the Pyth lazer message
    let ix_idx = load_current_index_checked(&ctx.accounts.ix_sysvar.to_account_info())?;
    validate!(
        ix_idx > 0,
        ErrorCode::InvalidVerificationIxIndex,
        "instruction index must be greater than 0 to include the sig verify ix"
    )?;

    let verified = pyth_lazer_sdk::verify_message(
        &ctx.accounts.pyth_lazer_storage,
        &ctx.accounts.ix_sysvar.to_account_info(),
        &pyth_message,
        ix_idx - 1,
        0,
        0,
    );

    if verified.is_err() {
        msg!("{:?}", verified);
        return Err(ErrorCode::UnverifiedPythLazerMessage.into());
    }

    // Load oracle accounts from remaining accounts
    let remaining_accounts = ctx.remaining_accounts;
    validate!(
        remaining_accounts.len() <= 3,
        ErrorCode::OracleTooManyPriceAccountUpdates
    )?;

    let data = PayloadData::deserialize_slice_le(verified.unwrap().payload)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let next_timestamp = data.timestamp_us.0;

    validate!(
        remaining_accounts.len() == data.feeds.len(),
        ErrorCode::OracleMismatchedVaaAndPriceUpdates
    )?;

    for (account, payload_data) in remaining_accounts.iter().zip(data.feeds.iter()) {
        let pyth_lazer_oracle_loader: AccountLoader<PythLazerOracle> =
            AccountLoader::try_from(account)?;
        let mut pyth_lazer_oracle = pyth_lazer_oracle_loader.load_mut()?;

        let feed_id = payload_data.feed_id.0;

        // Verify the pda
        let pda = Pubkey::find_program_address(
            &[PYTH_LAZER_ORACLE_SEED, &feed_id.to_le_bytes()],
            &crate::ID,
        )
        .0;
        require_keys_eq!(
            *account.key,
            pda,
            ErrorCode::OracleBadRemainingAccountPublicKey
        );

        let current_timestamp = pyth_lazer_oracle.publish_time;

        if next_timestamp > current_timestamp {
            let PayloadPropertyValue::Price(Some(price)) = payload_data.properties[0] else {
                return Err(ErrorCode::InvalidPythLazerMessage.into());
            };

            let mut best_bid_price: Option<Price> = None;
            let mut best_ask_price: Option<Price> = None;

            for property in &payload_data.properties {
                match property {
                    PayloadPropertyValue::BestBidPrice(price) => best_bid_price = *price,
                    PayloadPropertyValue::BestAskPrice(price) => best_ask_price = *price,
                    _ => {}
                }
            }

            // Default to 20bps of the price for conf if bid > ask or one-sided market
            let mut conf: i64 = price.0.get().safe_div(500)?;
            if let (Some(bid), Some(ask)) = (best_bid_price, best_ask_price) {
                if bid.0.get() < ask.0.get() {
                    conf = ask.0.get() - bid.0.get();
                }
            }

            pyth_lazer_oracle.price = price.0.get();
            pyth_lazer_oracle.posted_slot = Clock::get()?.slot;
            pyth_lazer_oracle.publish_time = next_timestamp;
            pyth_lazer_oracle.conf = conf.cast::<u64>()?;
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
    }

    Ok(())
}

#[derive(Accounts)]
pub struct UpdatePythLazerOracle<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    /// CHECK: Pyth lazer storage account not available to us
    #[account(
      address = PYTH_LAZER_STORAGE_ID @ ErrorCode::InvalidPythLazerStorageOwner
    )]
    pub pyth_lazer_storage: AccountInfo<'info>,
    /// CHECK: checked by ed25519 verify
    #[account(address = solana_program::sysvar::instructions::ID)]
    pub ix_sysvar: AccountInfo<'info>,
}
