use {
    crate::ExponentFactor,
    rust_decimal::{prelude::FromPrimitive, Decimal},
    serde::{Deserialize, Serialize},
    std::num::NonZeroI64,
    thiserror::Error,
};

#[derive(Debug, Error)]
pub enum PriceError {
    #[error("decimal parse error: {0}")]
    DecimalParse(#[from] rust_decimal::Error),
    #[error("price value is more precise than available exponent")]
    TooPrecise,
    #[error("zero price is unsupported")]
    ZeroPriceUnsupported,
    #[error("overflow")]
    Overflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(transparent)]
pub struct Price(NonZeroI64);

impl Price {
    pub fn from_integer(value: i64, exponent: i16) -> Result<Price, PriceError> {
        let mantissa = match ExponentFactor::get(exponent).ok_or(PriceError::Overflow)? {
            ExponentFactor::Mul(coef) => value.checked_mul(coef).ok_or(PriceError::Overflow)?,
            ExponentFactor::Div(coef) => value.checked_div(coef).ok_or(PriceError::Overflow)?,
        };
        let mantissa = NonZeroI64::new(mantissa).ok_or(PriceError::ZeroPriceUnsupported)?;
        Ok(Self(mantissa))
    }

    pub fn parse_str(value: &str, exponent: i16) -> Result<Price, PriceError> {
        let value: Decimal = value.parse()?;
        let mantissa = match ExponentFactor::get(exponent).ok_or(PriceError::Overflow)? {
            ExponentFactor::Mul(coef) => value
                .checked_mul(Decimal::from_i64(coef).ok_or(PriceError::Overflow)?)
                .ok_or(PriceError::Overflow)?,
            ExponentFactor::Div(coef) => value
                .checked_div(Decimal::from_i64(coef).ok_or(PriceError::Overflow)?)
                .ok_or(PriceError::Overflow)?,
        };
        if !mantissa.is_integer() {
            return Err(PriceError::TooPrecise);
        }
        let mantissa: i64 = mantissa.try_into().map_err(|_| PriceError::Overflow)?;
        let mantissa = NonZeroI64::new(mantissa).ok_or(PriceError::Overflow)?;
        Ok(Self(mantissa))
    }

    pub const fn from_nonzero_mantissa(mantissa: NonZeroI64) -> Self {
        Self(mantissa)
    }

    pub const fn from_mantissa(mantissa: i64) -> Result<Self, PriceError> {
        if let Some(mantissa) = NonZeroI64::new(mantissa) {
            Ok(Self(mantissa))
        } else {
            Err(PriceError::ZeroPriceUnsupported)
        }
    }

    pub fn mantissa(self) -> NonZeroI64 {
        self.0
    }

    pub fn mantissa_i64(self) -> i64 {
        self.0.get()
    }

    pub fn to_f64(self, exponent: i16) -> Result<f64, PriceError> {
        match ExponentFactor::get(exponent).ok_or(PriceError::Overflow)? {
            // Mul/div is reversed for converting mantissa to value
            ExponentFactor::Mul(coef) => Ok(self.0.get() as f64 / coef as f64),
            ExponentFactor::Div(coef) => Ok(self.0.get() as f64 * coef as f64),
        }
    }

    pub fn from_f64(value: f64, exponent: i16) -> Result<Self, PriceError> {
        let value = Decimal::from_f64(value).ok_or(PriceError::Overflow)?;
        let mantissa = match ExponentFactor::get(exponent).ok_or(PriceError::Overflow)? {
            ExponentFactor::Mul(coef) => value
                .checked_mul(Decimal::from_i64(coef).ok_or(PriceError::Overflow)?)
                .ok_or(PriceError::Overflow)?,
            ExponentFactor::Div(coef) => value
                .checked_div(Decimal::from_i64(coef).ok_or(PriceError::Overflow)?)
                .ok_or(PriceError::Overflow)?,
        };
        let mantissa: i64 = mantissa.try_into().map_err(|_| PriceError::Overflow)?;
        Ok(Self(
            NonZeroI64::new(mantissa).ok_or(PriceError::ZeroPriceUnsupported)?,
        ))
    }

    pub fn add_with_same_exponent(self, other: Price) -> Result<Self, PriceError> {
        let mantissa = self
            .0
            .get()
            .checked_add(other.0.get())
            .ok_or(PriceError::Overflow)?;
        Self::from_mantissa(mantissa).map_err(|_| PriceError::ZeroPriceUnsupported)
    }

    pub fn sub_with_same_exponent(self, other: Price) -> Result<Self, PriceError> {
        let mantissa = self
            .0
            .get()
            .checked_sub(other.0.get())
            .ok_or(PriceError::Overflow)?;
        Self::from_mantissa(mantissa).map_err(|_| PriceError::ZeroPriceUnsupported)
    }

    pub fn mul_integer(self, factor: i64) -> Result<Self, PriceError> {
        let mantissa = self
            .0
            .get()
            .checked_mul(factor)
            .ok_or(PriceError::Overflow)?;
        Self::from_mantissa(mantissa).map_err(|_| PriceError::ZeroPriceUnsupported)
    }

    pub fn div_integer(self, factor: i64) -> Result<Self, PriceError> {
        let mantissa = self
            .0
            .get()
            .checked_div(factor)
            .ok_or(PriceError::Overflow)?;
        Self::from_mantissa(mantissa).map_err(|_| PriceError::ZeroPriceUnsupported)
    }

    pub fn mul_decimal(self, mantissa: i64, exponent: i16) -> Result<Self, PriceError> {
        let left_mantissa = i128::from(self.0.get());
        let right_mantissa = i128::from(mantissa);

        // multiplied_mantissas = left_mantissa * right_mantissa
        let multiplied_mantissas = left_mantissa
            .checked_mul(right_mantissa)
            .ok_or(PriceError::Overflow)?;

        // result_mantissa = left_mantissa * right_mantissa * 10^exponent
        // Mul/div is reversed for multiplying 10^exponent
        let result_mantissa = match ExponentFactor::get(exponent).ok_or(PriceError::Overflow)? {
            ExponentFactor::Mul(coef) => multiplied_mantissas
                .checked_div(coef.into())
                .ok_or(PriceError::Overflow)?,
            ExponentFactor::Div(coef) => multiplied_mantissas
                .checked_mul(coef.into())
                .ok_or(PriceError::Overflow)?,
        };
        let result_mantissa: i64 = result_mantissa
            .try_into()
            .map_err(|_| PriceError::Overflow)?;
        Self::from_mantissa(result_mantissa).map_err(|_| PriceError::ZeroPriceUnsupported)
    }
}
