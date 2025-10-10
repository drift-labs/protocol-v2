/// Macro used to include code if the target_os is not 'solana'.
/// This is intended to be used for code that is primarily for off-chain Switchboard Functions.
#[macro_export]
macro_rules! cfg_client {
    ($($item:item)*) => {
        $(
            #[cfg(all(feature = "client"))]
            $item
        )*
    };
}

/// Helper macro to conditionally convert instruction types when both solana-v2 and client features are enabled
#[macro_export]
macro_rules! build_ix_compat {
    ($program_id:expr, $accounts:expr, $params:expr) => {{
        $crate::utils::build_ix($program_id, $accounts, $params)
    }};
}

/// Helper macro to wrap the final instruction return with type conversion if needed
/// When both solana-v2 and client features are enabled, code inside cfg_client! blocks
/// uses anchor's v3 types, but must return v2 types for compatibility
///
/// SAFETY: This uses unsafe transmute internally, which is safe because all Solana
/// Instruction types (v2, v3, anchor) have identical memory layout
#[macro_export]
macro_rules! return_ix_compat {
    ($ix:expr) => {{
        #[cfg(all(feature = "solana-v2", feature = "client"))]
        {
            // SAFETY: All Solana Instruction types have identical memory layout
            // (program_id: Pubkey, accounts: Vec<AccountMeta>, data: Vec<u8>)
            Ok(unsafe {
                $crate::instruction_compat::mixed_version::convert_any_instruction_to_compat_unsafe(
                    $ix,
                )
            }
            .to_v2())
        }
        #[cfg(not(all(feature = "solana-v2", feature = "client")))]
        {
            Ok($ix)
        }
    }};
}

/// Macro used to include code if the feature 'secrets' is enabled.
/// This is intended to be used for code that is primarily for off-chain Switchboard Secrets.
#[macro_export]
macro_rules! cfg_secrets {
    ($($item:item)*) => {
        $(
            #[cfg(all(feature = "secrets"))]
            $item
        )*
    };
}

/// Macro used to include storage code if the storage feature is enabled.
#[macro_export]
macro_rules! cfg_storage {
    ($($item:item)*) => {
        $(
            #[cfg(all(feature = "storage"))]
            $item
        )*
    };
}

/// Retry a given expression a specified number of times with a delay between each attempt.
///
/// # Arguments
///
/// * `attempts` - The number of attempts to make.
/// * `delay_ms` - The delay in milliseconds between each attempt.
/// * `expr` - The expression to be retried.
///
/// # Returns
///
/// Returns a `Result` containing the value of the expression if it succeeds within the specified number of attempts,
/// or an error if it fails on all attempts.
///
/// # Examples
/// ```
/// use switchboard_solana::retry;
///
/// // Retry a blockhash fetch 3 times with a delay of 500ms in between each failure
/// let blockhash = retry!(3, 500, rpc.get_latest_blockhash().await)
///     .await
///     .map_err(|e| OnDemandError::SolanaBlockhashFetchError(Arc::new(e)))?;
/// ```
#[macro_export]
macro_rules! retry {
    ($attempts:expr, $delay_ms:expr, $expr:expr) => {{
        async {
            let mut attempts = $attempts;
            loop {
                match $expr {
                    Ok(val) => break Ok(val),
                    Err(_) if attempts > 1 => {
                        attempts -= 1;
                        tokio::time::sleep(tokio::time::Duration::from_millis($delay_ms)).await;
                    }
                    Err(e) => break Err(e),
                }
            }
        }
    }};
}

/// Retry a given expression a specified number of times with a delay between each attempt.
/// This will block the current thread until a value is resolved or the maximum number of attempts is reached.
///
/// # Arguments
///
/// * `attempts` - The number of attempts to make.
/// * `delay_ms` - The delay in milliseconds between each attempt.
/// * `expr` - The expression to be retried.
///
/// # Returns
///
/// Returns a `Result` containing the value of the expression if it succeeds within the specified number of attempts,
/// or an error if it fails on all attempts.
///
/// # Examples
/// ```
/// use switchboard_solana::blocking_retry;
///
/// // Retry a blockhash fetch 3 times with a delay of 500ms in between each failure
/// let blockhash = blocking_retry!(3, 500, rpc.get_latest_blockhash())
///     .map_err(|e| OnDemandError::SolanaBlockhashFetchError(Arc::new(e)))?;
/// ```
#[macro_export]
macro_rules! blocking_retry {
    ($attempts:expr, $delay_ms:expr, $expr:expr) => {{
        let mut attempts = $attempts;
        loop {
            match $expr {
                Ok(val) => break Ok(val),
                Err(_) if attempts > 1 => {
                    attempts -= 1;
                    std::thread::sleep(tokio::time::Duration::from_millis($delay_ms));
                }
                Err(e) => break Err(e),
            }
        }
    }};
}

/// Implements AccountDeserialize trait for Anchor compatibility
#[macro_export]
macro_rules! impl_account_deserialize {
    ($struct_name:ident) => {
        use anchor_client;
        use anchor_lang::prelude::{Error, ErrorCode};

        impl anchor_client::anchor_lang::AccountDeserialize for $struct_name {
            fn try_deserialize(buf: &mut &[u8]) -> Result<Self, Error> {
                use $crate::anchor_traits::Discriminator;
                if buf.len() < $struct_name::discriminator().len() {
                    return Err(ErrorCode::AccountDiscriminatorMismatch.into());
                }
                let given_disc = &buf[..8];
                if $struct_name::discriminator() != given_disc {
                    return Err(ErrorCode::AccountDiscriminatorMismatch.into());
                }
                Self::try_deserialize_unchecked(buf)
            }

            fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self, Error> {
                let data: &[u8] = &buf[8..];
                bytemuck::try_from_bytes(data)
                    .map(|r: &Self| *r)
                    .map_err(|_| ErrorCode::AccountDidNotDeserialize.into())
            }
        }
    };
}
