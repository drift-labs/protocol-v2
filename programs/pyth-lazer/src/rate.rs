use {
    crate::ExponentFactor,
    rust_decimal::{prelude::FromPrimitive, Decimal},
    serde::{Deserialize, Serialize},
    thiserror::Error,
};

#[derive(Debug, Error)]
pub enum RateError {
    #[error("decimal parse error: {0}")]
    DecimalParse(#[from] rust_decimal::Error),
    #[error("price value is more precise than available exponent")]
    TooPrecise,
    #[error("overflow")]
    Overflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(transparent)]
pub struct Rate(i64);

impl Rate {
    pub fn from_integer(value: i64, exponent: i16) -> Result<Self, RateError> {
        let mantissa = match ExponentFactor::get(exponent).ok_or(RateError::Overflow)? {
            ExponentFactor::Mul(coef) => value.checked_mul(coef).ok_or(RateError::Overflow)?,
            ExponentFactor::Div(coef) => value.checked_div(coef).ok_or(RateError::Overflow)?,
        };
        Ok(Self(mantissa))
    }

    pub fn parse_str(value: &str, exponent: i16) -> Result<Self, RateError> {
        let value: Decimal = value.parse()?;
        let mantissa = match ExponentFactor::get(exponent).ok_or(RateError::Overflow)? {
            ExponentFactor::Mul(coef) => value
                .checked_mul(Decimal::from_i64(coef).ok_or(RateError::Overflow)?)
                .ok_or(RateError::Overflow)?,
            ExponentFactor::Div(coef) => value
                .checked_div(Decimal::from_i64(coef).ok_or(RateError::Overflow)?)
                .ok_or(RateError::Overflow)?,
        };
        if !mantissa.is_integer() {
            return Err(RateError::TooPrecise);
        }
        let mantissa: i64 = mantissa.try_into().map_err(|_| RateError::Overflow)?;
        Ok(Self(mantissa))
    }

    pub const fn from_mantissa(mantissa: i64) -> Self {
        Self(mantissa)
    }

    pub fn from_f64(value: f64, exponent: i16) -> Result<Self, RateError> {
        let value = Decimal::from_f64(value).ok_or(RateError::Overflow)?;
        let mantissa = match ExponentFactor::get(exponent).ok_or(RateError::Overflow)? {
            ExponentFactor::Mul(coef) => value
                .checked_mul(Decimal::from_i64(coef).ok_or(RateError::Overflow)?)
                .ok_or(RateError::Overflow)?,
            ExponentFactor::Div(coef) => value
                .checked_div(Decimal::from_i64(coef).ok_or(RateError::Overflow)?)
                .ok_or(RateError::Overflow)?,
        };
        let mantissa: i64 = mantissa.try_into().map_err(|_| RateError::Overflow)?;
        Ok(Self(mantissa))
    }

    pub fn mantissa(self) -> i64 {
        self.0
    }

    pub fn to_f64(self, exponent: i16) -> Result<f64, RateError> {
        match ExponentFactor::get(exponent).ok_or(RateError::Overflow)? {
            // Mul/div is reversed for converting mantissa to value
            ExponentFactor::Mul(coef) => Ok(self.0 as f64 / coef as f64),
            ExponentFactor::Div(coef) => Ok(self.0 as f64 * coef as f64),
        }
    }
}
