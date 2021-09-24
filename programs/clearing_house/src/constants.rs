pub const MANTISSA: u128 = 10_000_000_000; //expo = -10
pub const PEG_SCALAR: u128 = 1_000; //expo = -3
pub const PEG_SCALAR_COMPL: u128 = MANTISSA / PEG_SCALAR;
pub const USDC_PRECISION: u128 = 1_000_000;

pub const BASE_ASSET_AMT_PRECISION: u128 = MANTISSA * PEG_SCALAR;
pub const FUNDING_MANTISSA: u128 = 10_000; // expo = -4
