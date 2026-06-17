use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

use anchor_lang_idl::types::{
    Idl, IdlArrayLen, IdlDefinedFields, IdlField, IdlInstructionAccount,
    IdlInstructionAccountItem, IdlType, IdlTypeDef, IdlTypeDefTy,
};
use proc_macro2::TokenStream;
use quote::quote;
use sha2::Digest;
use syn::{Ident, Type};

/// Lower an `IdlType` to the Rust source string we emit.
///
/// Defined references collapse to just `Name` — generics are not currently
/// surfaced; if drift starts using generic types this needs revisiting.
fn idl_type_to_rust(t: &IdlType) -> String {
    match t {
        IdlType::Bool => "bool".into(),
        IdlType::U8 => "u8".into(),
        IdlType::I8 => "i8".into(),
        IdlType::U16 => "u16".into(),
        IdlType::I16 => "i16".into(),
        IdlType::U32 => "u32".into(),
        IdlType::I32 => "i32".into(),
        IdlType::F32 => "f32".into(),
        IdlType::U64 => "u64".into(),
        IdlType::I64 => "i64".into(),
        IdlType::F64 => "f64".into(),
        IdlType::U128 => "u128".into(),
        IdlType::I128 => "i128".into(),
        IdlType::U256 => "u256".into(),
        IdlType::I256 => "i256".into(),
        IdlType::Bytes => "Vec<u8>".into(),
        IdlType::String => "String".into(),
        IdlType::Pubkey => "Pubkey".into(),
        IdlType::Option(inner) => format!("Option<{}>", idl_type_to_rust(inner)),
        IdlType::Vec(inner) => format!("Vec<{}>", idl_type_to_rust(inner)),
        IdlType::Array(inner, len) => match len {
            IdlArrayLen::Value(n) => {
                let rust = idl_type_to_rust(inner);
                // [u8; 64] is the signature shape; alias to the Default-having `Signature` newtype.
                if *n == 64 && rust == "u8" {
                    "Signature".into()
                } else {
                    format!("[{}; {}]", rust, n)
                }
            }
            IdlArrayLen::Generic(name) => format!("[_; {name}]"),
        },
        IdlType::Defined { name, .. } => name.clone(),
        IdlType::Generic(name) => name.clone(),
        // anchor's `IdlType` is `#[non_exhaustive]`. Unreachable for current drift IDL.
        _ => panic!("unsupported IdlType variant: {t:?}"),
    }
}

/// Whether an `IdlType` is directly runtime-sized (`Vec`, `String`, `Bytes`).
/// Seeds the transitive analysis below.
fn idl_type_directly_dyn(t: &IdlType) -> bool {
    match t {
        IdlType::Vec(_) | IdlType::String | IdlType::Bytes => true,
        IdlType::Option(inner) | IdlType::Array(inner, _) => idl_type_directly_dyn(inner),
        _ => false,
    }
}

/// Names of `Defined` references reachable from an `IdlType` (transitively
/// through `Option/Array/Vec`).
fn idl_type_collect_defined<'a>(t: &'a IdlType, out: &mut Vec<&'a str>) {
    match t {
        IdlType::Defined { name, .. } => out.push(name.as_str()),
        IdlType::Option(inner) | IdlType::Array(inner, _) | IdlType::Vec(inner) => {
            idl_type_collect_defined(inner, out)
        }
        _ => {}
    }
}

fn defined_fields_iter(fields: &IdlDefinedFields) -> Box<dyn Iterator<Item = &IdlType> + '_> {
    match fields {
        IdlDefinedFields::Named(fs) => Box::new(fs.iter().map(|f| &f.ty)),
        IdlDefinedFields::Tuple(ts) => Box::new(ts.iter()),
    }
}

/// Type names that cannot derive `InitSpace` / `Copy` — they (transitively)
/// hold a `Vec`/`String`. The IDL doesn't carry `#[max_len(N)]` annotations,
/// so anchor's `InitSpace` derive would fail to expand.
fn compute_dyn_sized_types(types: &[IdlTypeDef]) -> HashSet<String> {
    let mut dyn_sized: HashSet<String> = HashSet::new();

    let direct_for = |td: &IdlTypeDefTy| -> bool {
        match td {
            IdlTypeDefTy::Struct { fields: Some(f) } => defined_fields_iter(f).any(idl_type_directly_dyn),
            IdlTypeDefTy::Enum { variants } => variants.iter().any(|v| {
                v.fields
                    .as_ref()
                    .map(|f| defined_fields_iter(f).any(idl_type_directly_dyn))
                    .unwrap_or(false)
            }),
            IdlTypeDefTy::Type { alias } => idl_type_directly_dyn(alias),
            _ => false,
        }
    };
    for t in types {
        if direct_for(&t.ty) {
            dyn_sized.insert(t.name.clone());
        }
    }

    // Fixed-point: a type is dyn-sized if any of its `Defined` references is.
    fn collect_refs<'a>(td: &'a IdlTypeDefTy, out: &mut Vec<&'a str>) {
        match td {
            IdlTypeDefTy::Struct { fields: Some(f) } => {
                for ty in defined_fields_iter(f) {
                    idl_type_collect_defined(ty, out);
                }
            }
            IdlTypeDefTy::Enum { variants } => {
                for v in variants {
                    if let Some(f) = &v.fields {
                        for ty in defined_fields_iter(f) {
                            idl_type_collect_defined(ty, out);
                        }
                    }
                }
            }
            IdlTypeDefTy::Type { alias } => idl_type_collect_defined(alias, out),
            _ => {}
        }
    }
    loop {
        let mut changed = false;
        for t in types {
            if dyn_sized.contains(&t.name) {
                continue;
            }
            let mut refs = Vec::new();
            collect_refs(&t.ty, &mut refs);
            if refs.iter().any(|r| dyn_sized.contains(*r)) {
                dyn_sized.insert(t.name.clone());
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    dyn_sized
}

fn rust_field(name: &str, ty: &IdlType) -> TokenStream {
    let field_name = Ident::new(&to_snake_case(name), proc_macro2::Span::call_site());
    let mut field_type: Type = syn::parse_str(&idl_type_to_rust(ty)).unwrap();

    // workaround for padding types preventing outertype from deriving 'Default'
    let mut serde_decorator = TokenStream::default();
    let fname_str = field_name.to_string();
    if fname_str.starts_with("padding") || fname_str.starts_with("_padding") {
        if let IdlType::Array(_, IdlArrayLen::Value(n)) = ty {
            field_type = syn::parse_str(&format!("Padding<{n}>")).unwrap();
            serde_decorator = quote! {
                #[serde(skip)]
            };
        }
    }

    quote! {
        #serde_decorator
        pub #field_name: #field_type,
    }
}

fn generate_idl_types(idl: &Idl) -> String {
    let mut instructions_tokens = quote! {};
    let mut types_tokens = quote! {};
    let mut accounts_tokens = quote! {};
    let mut events_tokens = quote! {};
    let mut errors_tokens = quote! {};
    let idl_version = syn::LitStr::new(&idl.metadata.version, proc_macro2::Span::call_site());

    let types_by_name: HashMap<&str, &IdlTypeDefTy> =
        idl.types.iter().map(|t| (t.name.as_str(), &t.ty)).collect();
    let named_struct_fields = |name: &str| -> &[IdlField] {
        match types_by_name.get(name) {
            Some(IdlTypeDefTy::Struct {
                fields: Some(IdlDefinedFields::Named(fs)),
            }) => fs.as_slice(),
            _ => &[],
        }
    };
    let dyn_sized = compute_dyn_sized_types(&idl.types);
    let is_dyn = |name: &str| dyn_sized.contains(name);

    // ---- types ----
    for type_def in &idl.types {
        let type_name = Ident::new(&type_def.name, proc_macro2::Span::call_site());
        // `IdlTypeDefTy` is `#[non_exhaustive]`; the wildcard arm is needed for
        // forward-compat but Rust can see all current variants are covered.
        #[allow(unreachable_patterns)]
        let type_tokens = match &type_def.ty {
            IdlTypeDefTy::Enum { variants } => {
                let has_complex_first = matches!(variants.first(), Some(v) if v.fields.is_some());

                let variant_tokens = variants.iter().enumerate().map(|(i, variant)| {
                    let variant_name =
                        Ident::new(&variant.name, proc_macro2::Span::call_site());
                    match &variant.fields {
                        None => {
                            if i == 0 {
                                quote! { #[default] #variant_name, }
                            } else {
                                quote! { #variant_name, }
                            }
                        }
                        Some(IdlDefinedFields::Named(fs)) => {
                            let field_tokens = fs.iter().map(|f| rust_field(&f.name, &f.ty));
                            if i == 0 && !has_complex_first {
                                quote! { #[default] #variant_name { #(#field_tokens)* }, }
                            } else {
                                quote! { #variant_name { #(#field_tokens)* }, }
                            }
                        }
                        Some(IdlDefinedFields::Tuple(ts)) => {
                            let elems = ts.iter().map(|t| {
                                let rt: Type = syn::parse_str(&idl_type_to_rust(t)).unwrap();
                                quote! { #rt }
                            });
                            if i == 0 && !has_complex_first {
                                quote! { #[default] #variant_name(#(#elems),*), }
                            } else {
                                quote! { #variant_name(#(#elems),*), }
                            }
                        }
                    }
                });

                if has_complex_first {
                    // TODO: complex-first enums get no `Default`. Not currently used by drift.
                    quote! {
                        #[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Serialize, Deserialize, Copy, Clone, Debug, PartialEq)]
                        pub enum #type_name {
                            #(#variant_tokens)*
                        }
                    }
                } else {
                    quote! {
                        #[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Serialize, Deserialize, Copy, Clone, Default, Debug, PartialEq)]
                        pub enum #type_name {
                            #(#variant_tokens)*
                        }
                    }
                }
            }
            IdlTypeDefTy::Struct { fields } => {
                let dyn_field = is_dyn(&type_def.name);
                let struct_fields: Vec<TokenStream> = match fields {
                    Some(IdlDefinedFields::Named(fs)) => {
                        fs.iter().map(|f| rust_field(&f.name, &f.ty)).collect()
                    }
                    Some(IdlDefinedFields::Tuple(ts)) => ts
                        .iter()
                        .enumerate()
                        .map(|(i, t)| {
                            let name = format!("field_{i}");
                            rust_field(&name, t)
                        })
                        .collect(),
                    None => Vec::new(),
                };

                let derives = if dyn_field {
                    quote! {
                        #[derive(AnchorSerialize, AnchorDeserialize, Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
                    }
                } else {
                    quote! {
                        #[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Serialize, Deserialize, Copy, Clone, Default, Debug, PartialEq)]
                    }
                };

                quote! {
                    #[repr(C)]
                    #derives
                    pub struct #type_name {
                        #(#struct_fields)*
                    }
                }
            }
            IdlTypeDefTy::Type { alias } => {
                let alias_ty: Type = syn::parse_str(&idl_type_to_rust(alias)).unwrap();
                quote! {
                    pub type #type_name = #alias_ty;
                }
            }
            // `IdlTypeDefTy` is `#[non_exhaustive]`.
            _ => quote! {},
        };

        types_tokens = quote! {
            #types_tokens
            #type_tokens
        };
    }

    // ---- accounts ----
    for account in &idl.accounts {
        let struct_name = Ident::new(&account.name, proc_macro2::Span::call_site());
        let has_dyn = is_dyn(&account.name);
        let fields = named_struct_fields(&account.name);
        let struct_fields: Vec<TokenStream> =
            fields.iter().map(|f| rust_field(&f.name, &f.ty)).collect();

        let derive_tokens = if !has_dyn {
            quote! {
                #[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Serialize, Deserialize, Copy, Clone, Default, Debug, PartialEq)]
            }
        } else {
            // can't derive `Copy`/`InitSpace` on accounts with `Vec` field
            quote! {
                #[derive(AnchorSerialize, AnchorDeserialize, Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
            }
        };

        let zc_tokens = if !has_dyn {
            quote! {
                #[automatically_derived]
                unsafe impl anchor_lang::__private::bytemuck::Pod for #struct_name {}
                #[automatically_derived]
                unsafe impl anchor_lang::__private::bytemuck::Zeroable for #struct_name {}
                #[automatically_derived]
                impl anchor_lang::ZeroCopy for #struct_name {}
            }
        } else {
            Default::default()
        };

        let discriminator: TokenStream = format!("{:?}", sighash("account", &account.name))
            .parse()
            .unwrap();
        let struct_def = quote! {
            #[repr(C)]
            #derive_tokens
            pub struct #struct_name {
                #(#struct_fields)*
            }
            #[automatically_derived]
            impl anchor_lang::Discriminator for #struct_name {
                const DISCRIMINATOR: &[u8] = &#discriminator;
            }
            #zc_tokens
            #[automatically_derived]
            impl anchor_lang::AccountSerialize for #struct_name {
                fn try_serialize<W: std::io::Write>(&self, writer: &mut W) -> anchor_lang::Result<()> {
                    if writer.write_all(Self::DISCRIMINATOR).is_err() {
                        return Err(anchor_lang::error::ErrorCode::AccountDidNotSerialize.into());
                    }

                    if AnchorSerialize::serialize(self, writer).is_err() {
                        return Err(anchor_lang::error::ErrorCode::AccountDidNotSerialize.into());
                    }

                    Ok(())
                }
            }
            #[automatically_derived]
            impl anchor_lang::AccountDeserialize for #struct_name {
                fn try_deserialize(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
                    let given_disc = &buf[..8];
                    if Self::DISCRIMINATOR != given_disc {
                        return Err(anchor_lang::error!(anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch));
                    }
                    Self::try_deserialize_unchecked(buf)
                }

                fn try_deserialize_unchecked(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
                    let mut data: &[u8] = &buf[8..];
                    AnchorDeserialize::deserialize(&mut data)
                        .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into())
                }
            }
        };

        accounts_tokens = quote! {
            #accounts_tokens
            #struct_def
        };
    }

    // ---- instructions ----
    for instr in &idl.instructions {
        // anchor 1.0 emits instruction names in snake_case.
        let name = to_pascal_case(&instr.name);
        let fn_name = to_snake_case(&instr.name);
        let struct_name = Ident::new(&name, proc_macro2::Span::call_site());

        let arg_fields = instr.args.iter().map(|a| rust_field(&a.name, &a.ty));
        // https://github.com/coral-xyz/anchor/blob/e48e7e60a64de77d878cdb063965cf125bec741a/lang/syn/src/codegen/program/instruction.rs#L32
        let discriminator: TokenStream = format!("{:?}", sighash("global", &fn_name))
            .parse()
            .unwrap();
        let struct_def = quote! {
            #[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
            pub struct #struct_name {
                #(#arg_fields)*
            }
            #[automatically_derived]
            impl anchor_lang::Discriminator for #struct_name {
                const DISCRIMINATOR: &[u8] = &#discriminator;
            }
            #[automatically_derived]
            impl anchor_lang::InstructionData for #struct_name {}
        };

        instructions_tokens = quote! {
            #instructions_tokens
            #struct_def
        };

        // Flatten composite account groups into a single Pubkey list, mirroring
        // the on-chain `instruction.accounts` shape.
        let mut flat_accounts: Vec<&IdlInstructionAccount> = Vec::new();
        fn flatten<'a>(
            items: &'a [IdlInstructionAccountItem],
            out: &mut Vec<&'a IdlInstructionAccount>,
        ) {
            for it in items {
                match it {
                    IdlInstructionAccountItem::Single(a) => out.push(a),
                    IdlInstructionAccountItem::Composite(g) => flatten(&g.accounts, out),
                }
            }
        }
        flatten(&instr.accounts, &mut flat_accounts);

        let accounts = flat_accounts.iter().map(|acc| {
            let account_name =
                Ident::new(&to_snake_case(&acc.name), proc_macro2::Span::call_site());
            quote! {
                pub #account_name: Pubkey,
            }
        });

        let to_account_metas = flat_accounts.iter().map(|acc| {
            let account_name =
                Ident::new(&to_snake_case(&acc.name), proc_macro2::Span::call_site());
            let is_mut: TokenStream = acc.writable.to_string().parse().unwrap();
            let is_signer: TokenStream = acc.signer.to_string().parse().unwrap();
            quote! {
                AccountMeta { pubkey: self.#account_name, is_signer: #is_signer, is_writable: #is_mut },
            }
        });

        let discriminator: TokenStream =
            format!("{:?}", sighash("account", &name)).parse().unwrap();
        let account_struct_def = quote! {
            #[repr(C)]
            #[derive(Copy, Clone, Default, AnchorSerialize, AnchorDeserialize, Serialize, Deserialize)]
            pub struct #struct_name {
                #(#accounts)*
            }
            #[automatically_derived]
            impl anchor_lang::Discriminator for #struct_name {
                const DISCRIMINATOR: &[u8] = &#discriminator;
            }
            #[automatically_derived]
            unsafe impl anchor_lang::__private::bytemuck::Pod for #struct_name {}
            #[automatically_derived]
            unsafe impl anchor_lang::__private::bytemuck::Zeroable for #struct_name {}
            #[automatically_derived]
            impl anchor_lang::ZeroCopy for #struct_name {}
            #[automatically_derived]
            impl anchor_lang::InstructionData for #struct_name {}
            #[automatically_derived]
            impl ToAccountMetas for #struct_name {
                fn to_account_metas(
                    &self,
                ) -> Vec<AccountMeta> {
                   vec![
                        #(#to_account_metas)*
                    ]
                }
            }
            #[automatically_derived]
            impl anchor_lang::AccountSerialize for #struct_name {
                fn try_serialize<W: std::io::Write>(&self, writer: &mut W) -> anchor_lang::Result<()> {
                    if writer.write_all(Self::DISCRIMINATOR).is_err() {
                        return Err(anchor_lang::error::ErrorCode::AccountDidNotSerialize.into());
                    }

                    if AnchorSerialize::serialize(self, writer).is_err() {
                        return Err(anchor_lang::error::ErrorCode::AccountDidNotSerialize.into());
                    }

                    Ok(())
                }
            }
            #[automatically_derived]
            impl anchor_lang::AccountDeserialize for #struct_name {
                fn try_deserialize(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
                    let given_disc = &buf[..8];
                    if Self::DISCRIMINATOR != given_disc {
                        return Err(anchor_lang::error!(anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch));
                    }
                    Self::try_deserialize_unchecked(buf)
                }

                fn try_deserialize_unchecked(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
                    let mut data: &[u8] = &buf[8..];
                    AnchorDeserialize::deserialize(&mut data)
                        .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into())
                }
            }
        };

        accounts_tokens = quote! {
            #accounts_tokens
            #account_struct_def
        };
    }

    // ---- errors ----
    let error_variants = idl.errors.iter().map(|error| {
        let variant_name = Ident::new(&error.name, proc_macro2::Span::call_site());
        let error_msg = error.msg.clone().unwrap_or_default();
        quote! {
            #[msg(#error_msg)]
            #variant_name,
        }
    });

    let error_enum = quote! {
        #[derive(PartialEq)]
        #[error_code]
        pub enum ErrorCode {
            #(#error_variants)*
        }
    };

    errors_tokens = quote! {
        #errors_tokens
        #error_enum
    };

    // ---- events ----
    for event in &idl.events {
        let struct_name = Ident::new(&event.name, proc_macro2::Span::call_site());
        let fields = named_struct_fields(&event.name)
            .iter()
            .map(|f| rust_field(&f.name, &f.ty));

        let struct_def = quote! {
            #[derive(Clone, Debug, PartialEq, Default)]
            #[event]
            pub struct #struct_name {
                #(#fields)*
            }
        };

        events_tokens = quote! {
            #events_tokens
            #struct_def
        };
    }

    let custom_types: TokenStream = include_str!("custom_types.rs")
        .parse()
        .expect("custom_types valid rust");

    // Wrap generated code in modules with necessary imports
    let output = quote! {
        #![allow(unused_imports)]
        //!
        //! Auto-generated IDL types, manual edits do not persist (see `crates/drift-idl-gen`)
        //!
        use anchor_lang::{prelude::{account, AnchorSerialize, AnchorDeserialize, InitSpace, event, error_code, msg, borsh::{self}}, Discriminator};
        // use solana-sdk Pubkey, the vendored anchor-lang Pubkey maybe behind
        use solana_pubkey::Pubkey;
        use solana_instruction::AccountMeta;
        use serde::{Serialize, Deserialize};

        pub const IDL_VERSION: &str = #idl_version;

        use self::traits::ToAccountMetas;
        pub mod traits {
            use crate::solana_sdk::instruction::AccountMeta;

            /// This is distinct from the anchor_lang version of the trait
            /// reimplemented to ensure the types used are from `solana`` crates _not_ the anchor_lang vendored versions which may be lagging behind
            pub trait ToAccountMetas {
                fn to_account_metas(&self) -> Vec<AccountMeta>;
            }
        }

        pub mod instructions {
            //! IDL instruction types
            use super::{*, types::*};

            #instructions_tokens
        }

        pub mod types {
            //! IDL types
            use std::ops::Mul;

            use super::*;
            #custom_types

            #types_tokens
        }

        pub mod accounts {
            //! IDL Account types
            use super::{*, types::*};

            #accounts_tokens
        }

        pub mod errors {
            //! IDL error types
            use super::{*, types::*};

            #errors_tokens
        }

        pub mod events {
            //! IDL event types
            use super::{*, types::*};
            #events_tokens
        }
    };

    output.to_string()
}

fn sighash(namespace: &str, name: &str) -> [u8; 8] {
    let preimage = format!("{namespace}:{name}");
    let mut hasher = sha2::Sha256::default();
    let mut sighash = <[u8; 8]>::default();
    hasher.update(preimage.as_bytes());
    let digest = hasher.finalize();
    sighash.copy_from_slice(&digest.as_slice()[..8]);

    sighash
}

fn to_snake_case(s: &str) -> String {
    let mut snake_case = String::new();
    for (i, c) in s.chars().enumerate() {
        if c.is_uppercase() {
            if i != 0 {
                snake_case.push('_');
            }
            snake_case.push(c.to_ascii_lowercase());
        } else {
            snake_case.push(c);
        }
    }
    snake_case
}

/// Convert snake_case (anchor 1.0 instruction names) to PascalCase.
/// Already-PascalCase input is preserved.
fn to_pascal_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut upper_next = true;
    for c in s.chars() {
        if c == '_' {
            upper_next = true;
        } else if upper_next {
            out.extend(c.to_uppercase());
            upper_next = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn format_rust_code(code: &str) -> String {
    let mut rustfmt = Command::new("rustfmt")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("Failed to run rustfmt");
    {
        let stdin = rustfmt.stdin.as_mut().expect("Failed to open stdin");
        stdin
            .write_all(code.as_bytes())
            .expect("Failed to write to stdin");
    }

    let output = rustfmt
        .wait_with_output()
        .expect("Failed to read rustfmt output");

    String::from_utf8(output.stdout).expect("rustfmt output is not valid UTF-8")
}

/// Generate rust types from IDL json
pub fn generate_rust_types(idl_path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let data = fs::read_to_string(idl_path)?;
    let idl: Idl = serde_json::from_str(&data)?;
    Ok(format_rust_code(&generate_idl_types(&idl)))
}
