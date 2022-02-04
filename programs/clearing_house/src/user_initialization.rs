use crate::context::InitializeUserOptionalAccounts;
use crate::error::ErrorCode;
use crate::optional_accounts::get_whitelist_token;
use crate::state::state::State;
use crate::state::user::{User, UserPositions};
use anchor_lang::prelude::*;

pub fn initialize(
    state: &Account<State>,
    user: &mut Box<Account<User>>,
    user_positions: &AccountLoader<UserPositions>,
    authority: &Signer,
    remaining_accounts: &[AccountInfo],
    optional_accounts: InitializeUserOptionalAccounts,
) -> ProgramResult {
    if !state.whitelist_mint.eq(&Pubkey::default()) {
        let whitelist_token =
            get_whitelist_token(optional_accounts, remaining_accounts, &state.whitelist_mint)?;

        if whitelist_token.is_none() {
            return Err(ErrorCode::WhitelistTokenNotFound.into());
        }

        let whitelist_token = whitelist_token.unwrap();
        if !whitelist_token.owner.eq(authority.key) {
            return Err(ErrorCode::InvalidWhitelistToken.into());
        }

        if whitelist_token.amount == 0 {
            return Err(ErrorCode::WhitelistTokenNotFound.into());
        }
    }

    user.authority = *authority.key;
    user.collateral = 0;
    user.cumulative_deposits = 0;
    user.positions = *user_positions.to_account_info().key;

    user.padding0 = 0;
    user.padding1 = 0;
    user.padding2 = 0;
    user.padding3 = 0;

    let user_positions = &mut user_positions.load_init()?;
    user_positions.user = *user.to_account_info().key;

    Ok(())
}
