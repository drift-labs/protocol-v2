#[macro_export]
macro_rules! validate {
        ($assert:expr, $err:expr) => {{
            if ($assert) {
                Ok(())
            } else {
                let error_code: ErrorCode = $err;
                msg!("Error {} thrown at {}:{}", error_code, file!(), line!());
                Err(error_code)
            }
        }};
        ($assert:expr, $err:expr, $($arg:tt)+) => {{
        if ($assert) {
            Ok(())
        } else {
            let error_code: ErrorCode = $err;
            msg!("Error {} thrown at {}:{}", error_code, file!(), line!());
            msg!($($arg)*);
            Err(error_code)
        }
    }};
}

#[macro_export]
macro_rules! declare_vault_seeds {
    ( $vault_loader:expr, $name: ident ) => {
        let vault = $vault_loader.load()?;
        let name = vault.name;
        let bump = vault.bump;
        let $name = &[&Vault::get_vault_signer_seeds(&name, &bump)[..]];
        drop(vault);
    };
}

#[macro_export]
macro_rules! implement_update_user_delegate_cpi {
    ( $self:expr, $delegate:expr ) => {
        declare_vault_seeds!($self.accounts.vault, seeds);

        let cpi_accounts = UpdateUser {
            user: $self.accounts.velocity_user.to_account_info().clone(),
            authority: $self.accounts.vault.to_account_info().clone(),
        };

        let velocity_program = $self.accounts.velocity_program.key();
        let cpi_context = CpiContext::new_with_signer(velocity_program, cpi_accounts, seeds);
        velocity::cpi::update_user_delegate(cpi_context, 0, $delegate)?;
    };
}

#[macro_export]
macro_rules! implement_update_user_reduce_only_cpi {
    ( $self:expr, $reduce_only:expr ) => {
        declare_vault_seeds!($self.accounts.vault, seeds);

        let cpi_accounts = UpdateUser {
            user: $self.accounts.velocity_user.to_account_info().clone(),
            authority: $self.accounts.vault.to_account_info().clone(),
        };

        let velocity_program = $self.accounts.velocity_program.key();
        let cpi_context = CpiContext::new_with_signer(velocity_program, cpi_accounts, seeds);
        velocity::cpi::update_user_reduce_only(cpi_context, 0, $reduce_only)?;
    };
}

#[macro_export]
macro_rules! implement_withdraw {
    ( $self:expr, $amount:expr ) => {
        declare_vault_seeds!($self.accounts.vault, seeds);

        let spot_market_index = $self.accounts.vault.load()?.spot_market_index;

        let cpi_accounts = VelocityWithdraw {
            state: $self.accounts.velocity_state.to_account_info().clone(),
            user: $self.accounts.velocity_user.to_account_info().clone(),
            user_stats: $self.accounts.velocity_user_stats.to_account_info().clone(),
            authority: $self.accounts.vault.to_account_info().clone(),
            spot_market_vault: $self
                .accounts
                .velocity_spot_market_vault
                .to_account_info()
                .clone(),
            velocity_signer: $self.accounts.velocity_signer.to_account_info().clone(),
            user_token_account: $self.accounts.vault_token_account.to_account_info().clone(),
            token_program: $self.accounts.token_program.to_account_info().clone(),
        };

        let velocity_program = $self.accounts.velocity_program.key();
        let cpi_context = CpiContext::new_with_signer(velocity_program, cpi_accounts, seeds)
            .with_remaining_accounts($self.remaining_accounts.into());
        velocity::cpi::withdraw(cpi_context, spot_market_index, $amount, false)?;
    };
}

#[macro_export]
macro_rules! implement_deposit {
    ( $self:expr, $amount:expr ) => {
        declare_vault_seeds!($self.accounts.vault, seeds);

        let spot_market_index = $self.accounts.vault.load()?.spot_market_index;

        let cpi_program = $self.accounts.velocity_program.key();
        let cpi_accounts = VelocityDeposit {
            state: $self.accounts.velocity_state.clone(),
            user: $self.accounts.velocity_user.to_account_info().clone(),
            user_stats: $self.accounts.velocity_user_stats.to_account_info().clone(),
            authority: $self.accounts.vault.to_account_info().clone(),
            spot_market_vault: $self
                .accounts
                .velocity_spot_market_vault
                .to_account_info()
                .clone(),
            user_token_account: $self.accounts.vault_token_account.to_account_info().clone(),
            token_program: $self.accounts.token_program.to_account_info().clone(),
        };
        let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, seeds)
            .with_remaining_accounts($self.remaining_accounts.into());
        velocity::cpi::deposit(cpi_context, spot_market_index, $amount, false)?;
    };
}

#[cfg(test)]
#[macro_export]
macro_rules! assert_eq_within {
    ($left:expr, $right:expr, $tolerance:expr $(,)?) => {
        assert!(($left).abs_diff($right) <= $tolerance,
            "\nAssertion failed: values differ by more than {tolerance}\n  Left: {left}\n Right: {right}\n  Diff: {diff}",
            tolerance = $tolerance,
            left = $left,
            right = $right,
            diff = ($left).abs_diff($right)
        );
    };
    ($left:expr, $right:expr, $tolerance:expr, $($arg:tt)+) => {
        assert!(($left).abs_diff($right) <= $tolerance,
            "\nAssertion failed: {}\n  Left: {left}\n Right: {right}\n  Diff: {diff}\n  Max allowed diff: {tolerance}",
            format!($($arg)+),
            tolerance = $tolerance,
            left = $left,
            right = $right,
            diff = ($left).abs_diff($right)
        )
    };
}
