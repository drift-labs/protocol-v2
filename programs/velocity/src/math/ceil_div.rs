use crate::math::bn::{U192, U256};
use num_traits::{One, Zero};

pub trait CheckedCeilDiv: Sized {
    /// Perform ceiling division
    fn checked_ceil_div(&self, rhs: Self) -> Option<Self>;
}

macro_rules! checked_impl {
    ($t:ty) => {
        impl CheckedCeilDiv for $t {
            #[track_caller]
            #[inline]
            fn checked_ceil_div(&self, rhs: $t) -> Option<$t> {
                let quotient = self.checked_div(rhs)?;

                let remainder = self.checked_rem(rhs)?;

                if remainder > <$t>::zero() {
                    quotient.checked_add(<$t>::one())
                } else {
                    Some(quotient)
                }
            }
        }
    };
}

checked_impl!(U256);
checked_impl!(U192);
checked_impl!(u128);
checked_impl!(u64);
checked_impl!(u32);
checked_impl!(u16);
checked_impl!(u8);
checked_impl!(i128);
checked_impl!(i64);
checked_impl!(i32);
checked_impl!(i16);
checked_impl!(i8);
