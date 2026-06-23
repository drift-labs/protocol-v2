//! Procedural macros for Velocity zero-copy account structs.
//!
//! Vendored and trimmed from `velocity-exchange/drift-macros` (Apache-2.0): only the
//! `assert_no_slop` attribute is kept. The upstream `legacy_layout` macro is
//! dropped, as it hardcodes a `crate::math::bn::compat` path that does not exist
//! in this layout and is unused.

extern crate proc_macro;

use proc_macro::TokenStream;
use quote::{format_ident, quote};
use syn::{parse_macro_input, Data, DeriveInput, Fields};

/// Compile-time guard that a struct carries no implicit padding ("slop") between
/// its fields: it asserts `size_of::<Struct>() == sum(size_of::<field>())`.
///
/// Used on zero-copy account structs where the in-memory byte layout must match
/// the on-chain representation exactly. The expansion emits `const_assert_eq!`,
/// so the use site must have `static_assertions::const_assert_eq` in scope.
#[allow(clippy::panic)]
#[proc_macro_attribute]
pub fn assert_no_slop(_: TokenStream, input: TokenStream) -> TokenStream {
    let derive_input = parse_macro_input!(input as DeriveInput);
    let struct_name = &derive_input.ident;
    let struct_name_uppercase = struct_name.to_string().to_uppercase();

    let expanded = match &derive_input.data {
        Data::Struct(data_struct) => {
            let field_sizes: Vec<_> = match &data_struct.fields {
                Fields::Named(fields) => fields.named.iter().map(|field| &field.ty).collect(),
                Fields::Unnamed(fields) => fields.unnamed.iter().map(|field| &field.ty).collect(),
                Fields::Unit => panic!("assert_no_slop cannot be used on unit structs"),
            };

            let sizes_sum = quote! { #(std::mem::size_of::<#field_sizes>())+* };
            let struct_size_name = format_ident!("{}_STRUCT_SIZE", struct_name_uppercase);
            let field_sizes_name = format_ident!("{}_FIELD_SIZES", struct_name_uppercase);

            quote! {
                const #struct_size_name: usize = std::mem::size_of::<#struct_name>();
                const #field_sizes_name: usize = #sizes_sum;

                const_assert_eq!(#struct_size_name, #field_sizes_name);
            }
        }
        _ => panic!("assert_no_slop can only be used on structs"),
    };

    quote! {
        #derive_input
        #expanded
    }
    .into()
}
