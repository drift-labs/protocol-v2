# drfit-idl-gen

⚠️ for drift-rs there's no need to run this manually. The `build.rs` script will trigger it.

Generates rust anchor structs from IDL json
This is implemented rather than another project for a couple reasons:

1) `#[repr(C)]` other IDL generation tools do not provide the ability to market structs with `repr(C)` which is necessary for ffi functionality throught the drift-rs project.
2) does not rely on anchor vendored solana crates. anchor is pinned to older versions of the solana crates. drift-rs seeks to be readily upgradable to use lastest solana crates.

## Dev Note ⚠️
- An important assumption in this code is that the underlying types (serialization and deserialization) does not change among solana crate versions i.e `solana_sdk_1.16::Pubkey == solana_sdk_2.x::Pubkey == anchor_lang::solana_sdk::Pubkey`
this allows the generated IDL code to ignore the anchor version of crates.