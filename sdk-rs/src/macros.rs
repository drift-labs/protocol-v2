#[macro_export]
macro_rules! assert {
    ($assert:expr) => {{
        if !$assert {
            panic!("assertion failed: {}", stringify!($assert));
        }
    }};
    ($assert:expr, $($arg:tt)+) => {{
        if !$assert {
            panic!("assertion failed: {}: {}", stringify!($assert), format_args!($($arg)+));
        }
    }};
}
