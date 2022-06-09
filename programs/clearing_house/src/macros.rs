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
