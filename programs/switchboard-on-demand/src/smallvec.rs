//! Small vector types with compact length prefixes for Borsh serialization.
//!
//! Standard Borsh uses 4-byte (u32) length prefixes for vectors. These types
//! use smaller prefixes (1 or 2 bytes) to save space when the maximum length
//! is known to be small.
//!
//! SmallVec is stack-allocated with a maximum capacity of 8 elements.

use anchor_lang::prelude::borsh::{BorshDeserialize, BorshSerialize};
use core::mem::MaybeUninit;

/// Trait for length prefix encoding/decoding
pub trait LengthPrefix: Copy {
    /// Maximum capacity this prefix can represent
    const MAX_CAPACITY: usize;

    /// Serialize the length to a writer
    fn serialize_length<W: std::io::Write>(len: usize, writer: &mut W) -> std::io::Result<()>;

    /// Deserialize the length from a reader
    fn deserialize_length<R: std::io::Read>(reader: &mut R) -> std::io::Result<usize>;
}

/// 1-byte (u8) length prefix - max 255 elements
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct U8Prefix;

impl LengthPrefix for U8Prefix {
    const MAX_CAPACITY: usize = u8::MAX as usize;

    fn serialize_length<W: std::io::Write>(len: usize, writer: &mut W) -> std::io::Result<()> {
        if len > Self::MAX_CAPACITY {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Length {} exceeds u8::MAX ({})", len, Self::MAX_CAPACITY),
            ));
        }
        writer.write_all(&[len as u8])
    }

    fn deserialize_length<R: std::io::Read>(reader: &mut R) -> std::io::Result<usize> {
        let mut buf = [0u8; 1];
        reader.read_exact(&mut buf)?;
        Ok(buf[0] as usize)
    }
}

/// 2-byte (u16) length prefix - max 65535 elements
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct U16Prefix;

impl LengthPrefix for U16Prefix {
    const MAX_CAPACITY: usize = u16::MAX as usize;

    fn serialize_length<W: std::io::Write>(len: usize, writer: &mut W) -> std::io::Result<()> {
        if len > Self::MAX_CAPACITY {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Length {} exceeds u16::MAX ({})", len, Self::MAX_CAPACITY),
            ));
        }
        writer.write_all(&(len as u16).to_le_bytes())
    }

    fn deserialize_length<R: std::io::Read>(reader: &mut R) -> std::io::Result<usize> {
        let mut buf = [0u8; 2];
        reader.read_exact(&mut buf)?;
        Ok(u16::from_le_bytes(buf) as usize)
    }
}

/// Small vector with configurable length prefix size for compact Borsh serialization.
///
/// **Stack-allocated with maximum 8 elements.**
///
/// **Key Difference from Standard Borsh:**
/// - Standard Borsh Vec: Uses 4-byte (u32) length prefix, heap-allocated
/// - SmallVec<T, U8Prefix>: Uses 1-byte (u8) length prefix, stack-allocated (max 8 elements)
/// - SmallVec<T, U16Prefix>: Uses 2-byte (u16) length prefix, stack-allocated (max 8 elements)
///
/// # Serialization Format
/// ```text
/// [length: 1 or 2 bytes][element_0][element_1]...[element_n]
/// ```
///
/// # Example Size Comparison
/// For a Vec<u32> with 3 elements:
/// - Standard Vec: 4 bytes (length) + 12 bytes (data) = 16 bytes
/// - SmallVec<_, U8Prefix>: 1 byte (length) + 12 bytes (data) = 13 bytes (3 bytes saved)
/// - SmallVec<_, U16Prefix>: 2 bytes (length) + 12 bytes (data) = 14 bytes (2 bytes saved)
///
/// # Examples
///
/// ```rust
/// use switchboard_on_demand::smallvec::{SmallVec, U8Prefix, U16Prefix};
///
/// // For small arrays (max 8 elements)
/// let feeds: SmallVec<u32, U8Prefix> = vec![1, 2, 3].into();
///
/// // For signatures (max 8 elements)
/// let signatures: SmallVec<u64, U16Prefix> = vec![10, 20, 30].into();
/// ```
pub struct SmallVec<T, P: LengthPrefix = U8Prefix> {
    data: [MaybeUninit<T>; 8],
    len: u8,
    _phantom: core::marker::PhantomData<P>,
}

impl<T, P: LengthPrefix> SmallVec<T, P> {
    /// Maximum capacity for SmallVec (stack-allocated)
    pub const MAX_CAPACITY: usize = 8;

    /// Creates an empty SmallVec
    pub fn new() -> Self {
        Self {
            data: unsafe { MaybeUninit::uninit().assume_init() },
            len: 0,
            _phantom: core::marker::PhantomData,
        }
    }

    /// Creates a SmallVec with the specified capacity (reserved for future use)
    pub fn with_capacity(_capacity: usize) -> Self {
        Self::new()
    }

    /// Appends an element to the back of the collection
    pub fn push(&mut self, value: T) {
        assert!(
            (self.len as usize) < Self::MAX_CAPACITY,
            "SmallVec exceeds max capacity: {} >= {}",
            self.len,
            Self::MAX_CAPACITY
        );
        self.data[self.len as usize] = MaybeUninit::new(value);
        self.len += 1;
    }

    /// Returns the number of elements in the vector
    pub fn len(&self) -> usize {
        self.len as usize
    }

    /// Returns true if the vector contains no elements
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Extracts a slice containing the entire vector
    pub fn as_slice(&self) -> &[T] {
        unsafe {
            core::slice::from_raw_parts(
                self.data.as_ptr() as *const T,
                self.len as usize
            )
        }
    }

    /// Returns a mutable slice
    pub fn as_mut_slice(&mut self) -> &mut [T] {
        unsafe {
            core::slice::from_raw_parts_mut(
                self.data.as_mut_ptr() as *mut T,
                self.len as usize
            )
        }
    }

    /// Returns an iterator over the slice
    pub fn iter(&self) -> core::slice::Iter<'_, T> {
        self.as_slice().iter()
    }

    /// Returns a mutable iterator over the slice
    pub fn iter_mut(&mut self) -> core::slice::IterMut<'_, T> {
        self.as_mut_slice().iter_mut()
    }
}

impl<T, P: LengthPrefix> Drop for SmallVec<T, P> {
    fn drop(&mut self) {
        // Drop all initialized elements
        for i in 0..self.len as usize {
            unsafe {
                self.data[i].assume_init_drop();
            }
        }
    }
}

impl<T: Clone, P: LengthPrefix> Clone for SmallVec<T, P> {
    fn clone(&self) -> Self {
        let mut result = Self::new();
        for item in self.as_slice() {
            result.push(item.clone());
        }
        result
    }
}

impl<T: core::fmt::Debug, P: LengthPrefix> core::fmt::Debug for SmallVec<T, P> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_list().entries(self.as_slice()).finish()
    }
}

impl<T: PartialEq, P: LengthPrefix> PartialEq for SmallVec<T, P> {
    fn eq(&self, other: &Self) -> bool {
        self.as_slice() == other.as_slice()
    }
}

impl<T: Eq, P: LengthPrefix> Eq for SmallVec<T, P> {}

impl<T, P: LengthPrefix> Default for SmallVec<T, P> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T, P: LengthPrefix> core::ops::Deref for SmallVec<T, P> {
    type Target = [T];

    fn deref(&self) -> &Self::Target {
        self.as_slice()
    }
}

impl<T, P: LengthPrefix> core::ops::DerefMut for SmallVec<T, P> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.as_mut_slice()
    }
}

impl<T, P: LengthPrefix> From<Vec<T>> for SmallVec<T, P> {
    fn from(vec: Vec<T>) -> Self {
        assert!(
            vec.len() <= Self::MAX_CAPACITY,
            "Vec length {} exceeds SmallVec max capacity {}",
            vec.len(),
            Self::MAX_CAPACITY
        );
        let mut result = Self::new();
        for item in vec {
            result.push(item);
        }
        result
    }
}

impl<T: BorshSerialize, P: LengthPrefix> BorshSerialize for SmallVec<T, P> {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        // Write length using the prefix strategy
        P::serialize_length(self.len as usize, writer)?;

        // Write each element
        for item in self.as_slice() {
            item.serialize(writer)?;
        }
        Ok(())
    }
}

impl<T: BorshDeserialize, P: LengthPrefix> BorshDeserialize for SmallVec<T, P> {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        // Read length using the prefix strategy
        let len = P::deserialize_length(reader)?;

        if len > Self::MAX_CAPACITY {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Deserialized length {} exceeds max capacity {}", len, Self::MAX_CAPACITY),
            ));
        }

        // Read elements
        let mut result = Self::new();
        for _ in 0..len {
            result.push(T::deserialize_reader(reader)?);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_u8_prefix_serialization() {
        let small_vec: SmallVec<u32, U8Prefix> = vec![1, 2, 3].into();
        let mut serialized = Vec::new();
        small_vec.serialize(&mut serialized).unwrap();

        // First byte should be the length (3)
        assert_eq!(serialized[0], 3u8, "First byte should be length as u8");

        // Total size: 1 byte (length) + 3 * 4 bytes (u32s) = 13 bytes
        assert_eq!(serialized.len(), 1 + 3 * 4);

        // Test deserialization
        let mut slice = serialized.as_slice();
        let deserialized = SmallVec::<u32, U8Prefix>::deserialize(&mut slice).unwrap();
        assert_eq!(deserialized.as_slice(), &[1, 2, 3]);
    }

    #[test]
    fn test_u16_prefix_serialization() {
        let small_vec: SmallVec<u32, U16Prefix> = vec![1, 2, 3].into();
        let mut serialized = Vec::new();
        small_vec.serialize(&mut serialized).unwrap();

        // First 2 bytes should be the length (3) as u16 little-endian
        assert_eq!(serialized[0..2], [3u8, 0u8], "First 2 bytes should be length as u16 LE");

        // Total size: 2 bytes (length) + 3 * 4 bytes (u32s) = 14 bytes
        assert_eq!(serialized.len(), 2 + 3 * 4);

        // Test deserialization
        let mut slice = serialized.as_slice();
        let deserialized = SmallVec::<u32, U16Prefix>::deserialize(&mut slice).unwrap();
        assert_eq!(deserialized.as_slice(), &[1, 2, 3]);
    }

    #[test]
    fn test_size_comparison() {
        // Standard Vec
        let regular_vec = vec![1u32, 2u32, 3u32];
        let mut regular_serialized = Vec::new();
        regular_vec.serialize(&mut regular_serialized).unwrap();

        // SmallVec with U8Prefix
        let small_vec_u8: SmallVec<u32, U8Prefix> = vec![1, 2, 3].into();
        let mut small_u8_serialized = Vec::new();
        small_vec_u8.serialize(&mut small_u8_serialized).unwrap();

        // SmallVec with U16Prefix
        let small_vec_u16: SmallVec<u32, U16Prefix> = vec![1, 2, 3].into();
        let mut small_u16_serialized = Vec::new();
        small_vec_u16.serialize(&mut small_u16_serialized).unwrap();

        println!("Size comparison for Vec<u32> with 3 elements:");
        println!("  Standard Vec:          {} bytes", regular_serialized.len());
        println!("  SmallVec<_, U8Prefix>: {} bytes (saves {} bytes)",
            small_u8_serialized.len(),
            regular_serialized.len() - small_u8_serialized.len());
        println!("  SmallVec<_, U16Prefix>: {} bytes (saves {} bytes)",
            small_u16_serialized.len(),
            regular_serialized.len() - small_u16_serialized.len());

        assert_eq!(regular_serialized.len(), 16);  // 4 + 12
        assert_eq!(small_u8_serialized.len(), 13); // 1 + 12
        assert_eq!(small_u16_serialized.len(), 14); // 2 + 12
    }

    #[test]
    #[should_panic(expected = "exceeds max capacity")]
    fn test_overflow() {
        let mut small_vec: SmallVec<u8, U8Prefix> = SmallVec::new();
        // Try to push 9 elements into an 8-element capacity vector
        for i in 0..=8 {
            small_vec.push(i);
        }
    }

    #[test]
    fn test_max_capacity() {
        let mut small_vec: SmallVec<u8, U8Prefix> = SmallVec::new();
        // Should be able to push exactly 8 elements
        for i in 0..8 {
            small_vec.push(i);
        }
        assert_eq!(small_vec.len(), 8);
        assert_eq!(small_vec.as_slice(), &[0, 1, 2, 3, 4, 5, 6, 7]);
    }
}
