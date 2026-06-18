// ****
// Custom type defintions
///
// these are not generated from IDL but are useful for better compatibility or utility
// ****

/// backwards compatible u128 deserializing data from rust <=1.76.0 when u/i128 was 8-byte aligned
/// https://solana.stackexchange.com/questions/7720/using-u128-without-sacrificing-alignment-8
#[derive(
    Default,
    PartialEq,
    AnchorSerialize,
    AnchorDeserialize,
    Serialize,
    Deserialize,
    Copy,
    Clone,
    bytemuck::Zeroable,
    bytemuck::Pod,
    Debug,
)]
#[repr(C)]
pub struct u128(pub [u8; 16]);

impl u128 {
    /// convert self into the std `u128` type
    pub fn as_u128(&self) -> std::primitive::u128 {
        std::primitive::u128::from_le_bytes(self.0)
    }
}

impl From<std::primitive::u128> for self::u128 {
    fn from(value: std::primitive::u128) -> Self {
        Self(value.to_le_bytes())
    }
}

/// backwards compatible i128 deserializing data from rust <=1.76.0 when u/i128 was 8-byte aligned
/// https://solana.stackexchange.com/questions/7720/using-u128-without-sacrificing-alignment-8
#[derive(
    Default,
    PartialEq,
    AnchorSerialize,
    AnchorDeserialize,
    Serialize,
    Deserialize,
    Copy,
    Clone,
    bytemuck::Zeroable,
    bytemuck::Pod,
    Debug,
)]
#[repr(C)]
pub struct i128(pub [u8; 16]);

impl i128 {
    /// convert self into the std `i128` type
    pub fn as_i128(&self) -> core::primitive::i128 {
        core::primitive::i128::from_le_bytes(self.0)
    }
}

impl From<core::primitive::i128> for i128 {
    fn from(value: core::primitive::i128) -> Self {
        Self(value.to_le_bytes())
    }
}

#[repr(transparent)]
#[derive(AnchorDeserialize, AnchorSerialize, Copy, Clone, PartialEq, Debug)]
pub struct Signature(pub [u8; 64]);

impl Default for Signature {
    fn default() -> Self {
        Self([0_u8; 64])
    }
}

impl serde::Serialize for Signature {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_bytes(&self.0)
    }
}

impl<'de> serde::Deserialize<'de> for Signature {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = <&[u8]>::deserialize(d)?;
        s.try_into()
            .map(Signature)
            .map_err(serde::de::Error::custom)
    }
}

impl anchor_lang::Space for Signature {
    const INIT_SPACE: usize = 8 * 64;
}

/// wrapper around fixed array types used for padding with `Default` implementation
#[repr(transparent)]
#[derive(AnchorDeserialize, AnchorSerialize, Copy, Clone, PartialEq)]
pub struct Padding<const N: usize>([u8; N]);
impl<const N: usize> Default for Padding<N> {
    fn default() -> Self {
        Self([0u8; N])
    }
}

impl<const N: usize> std::fmt::Debug for Padding<N> {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // don't print anything for padding...
        Ok(())
    }
}

impl<const N: usize> anchor_lang::Space for Padding<N> {
    const INIT_SPACE: usize = 8 * N;
}
