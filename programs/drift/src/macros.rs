#[macro_export]
macro_rules! get_struct_values {
    ($struct:expr, $($property: ident),+) => {{
        ($(
            $struct.$property,
        )+)
    }};
}

#[macro_export]
macro_rules! get_then_update_id {
    ($struct:expr, $property: ident) => {{
        let current_id = $struct.$property;
        $struct.$property = current_id.checked_add(1).or(Some(1)).unwrap();
        current_id
    }};
}

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
macro_rules! dlog {
    ($($variable: expr),+) => {{
        $(
            msg!("{}: {}", stringify!($variable), $variable);
        )+
    }};
    ($($arg:tt)+) => {{
            #[cfg(not(feature = "mainnet-beta"))]
            msg!($($arg)+);
    }};
}

#[macro_export]
macro_rules! load_mut {
    ($account_loader:expr) => {{
        $account_loader.load_mut().map_err(|e| {
            msg!("e {:?}", e);
            let error_code = ErrorCode::UnableToLoadAccountLoader;
            msg!("Error {} thrown at {}:{}", error_code, file!(), line!());
            error_code
        })
    }};
}

#[macro_export]
macro_rules! load {
    ($account_loader:expr) => {{
        $account_loader.load().map_err(|_| {
            let error_code = ErrorCode::UnableToLoadAccountLoader;
            msg!("Error {} thrown at {}:{}", error_code, file!(), line!());
            error_code
        })
    }};
}

#[macro_export]
macro_rules! safe_increment {
    ($struct:expr, $value:expr) => {{
        $struct = $struct.checked_add($value).ok_or_else(math_error!())?
    }};
}

#[macro_export]
macro_rules! safe_decrement {
    ($struct:expr, $value:expr) => {{
        $struct = $struct.checked_sub($value).ok_or_else(math_error!())?
    }};
}

/// Calculate the sha256 digest of anchor encoded `struct`
#[macro_export]
macro_rules! digest_struct {
    ($struct:expr) => {
        solana_program::hash::hash(&$struct.try_to_vec().unwrap()).to_bytes()
    };
}

/// Calculate the hexified sha256 digest of anchor encoded `struct`
#[macro_export]
macro_rules! digest_struct_hex {
    ($struct:expr) => {{
        hex::encode(digest_struct!($struct)).into_bytes()
    }};
}

/// same as `solana_program::msg!` but it can compile away for off-chain use
#[macro_export]
macro_rules! msg {
    ($msg:expr) => {
        #[cfg(not(feature = "drift-rs"))]
        solana_program::msg!($msg)
    };
    ($($arg:tt)*) => {
        #[cfg(not(feature = "drift-rs"))]
        (solana_program::msg!(&format!($($arg)*)));
    }
}
