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
        ($assert:expr, $err:expr, $($arg:tt)*) => {{
        if ($assert) {
            Ok(())
        } else {
            let error_code: ErrorCode = $err;
            msg!("Error {} thrown at {}:{}", error_code, file!(), line!());
            msg!($($arg)*);
            Err(error_code)
        }
    }};
    ($assert:expr, $err:expr) => {{
        if ($assert) {
            Ok(())
        } else {
            let error_code: ErrorCode = $err;
            msg!("Error {} thrown at {}:{}", error_code, file!(), line!());
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
