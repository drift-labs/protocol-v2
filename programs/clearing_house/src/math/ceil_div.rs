pub trait CheckedCeilDiv: Sized {
    /// Perform ceiling division
    fn checked_ceil_div(&self, rhs: Self) -> Option<Self>;
}

impl CheckedCeilDiv for u128 {
    fn checked_ceil_div(&self, rhs: Self) -> Option<Self> {
        let quotient = self.checked_div(rhs)?;

        let remainder = self.checked_rem(rhs)?;

        if remainder > 0 && rhs > 0 {
            quotient.checked_add(1)
        } else {
            Some(quotient)
        }
    }
}
