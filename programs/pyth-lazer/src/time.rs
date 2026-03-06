use {
    anyhow::Context,
    serde::{Deserialize, Serialize},
    std::convert::TryFrom,
    std::time::{Duration, SystemTime},
};

/// Unix timestamp with microsecond resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(transparent)]
pub struct TimestampUs(u64);

#[cfg_attr(feature = "mry", mry::mry)]
impl TimestampUs {
    pub fn now() -> Self {
        SystemTime::now().try_into().expect("invalid system time")
    }
}

impl TimestampUs {
    pub const UNIX_EPOCH: Self = Self(0);
    pub const MAX: Self = Self(u64::MAX);

    #[inline]
    pub const fn from_micros(micros: u64) -> Self {
        Self(micros)
    }

    #[inline]
    pub const fn as_micros(self) -> u64 {
        self.0
    }

    #[inline]
    pub fn as_nanos(self) -> u128 {
        // never overflows
        u128::from(self.0) * 1000
    }

    #[inline]
    pub fn as_nanos_i128(self) -> i128 {
        // never overflows
        i128::from(self.0) * 1000
    }

    #[inline]
    pub fn from_nanos(nanos: u128) -> anyhow::Result<Self> {
        let micros = nanos
            .checked_div(1000)
            .context("nanos.checked_div(1000) failed")?;
        Ok(Self::from_micros(micros.try_into()?))
    }

    #[inline]
    pub fn from_nanos_i128(nanos: i128) -> anyhow::Result<Self> {
        let micros = nanos
            .checked_div(1000)
            .context("nanos.checked_div(1000) failed")?;
        Ok(Self::from_micros(micros.try_into()?))
    }

    #[inline]
    pub fn as_millis(self) -> u64 {
        self.0 / 1000
    }

    #[inline]
    pub fn from_millis(millis: u64) -> anyhow::Result<Self> {
        let micros = millis
            .checked_mul(1000)
            .context("millis.checked_mul(1000) failed")?;
        Ok(Self::from_micros(micros))
    }

    #[inline]
    pub fn as_secs(self) -> u64 {
        self.0 / 1_000_000
    }

    #[inline]
    pub fn from_secs(secs: u64) -> anyhow::Result<Self> {
        let micros = secs
            .checked_mul(1_000_000)
            .context("secs.checked_mul(1_000_000) failed")?;
        Ok(Self::from_micros(micros))
    }

    #[inline]
    pub fn duration_since(self, other: Self) -> anyhow::Result<DurationUs> {
        Ok(DurationUs(
            self.0
                .checked_sub(other.0)
                .context("timestamp.checked_sub(duration) failed")?,
        ))
    }

    #[inline]
    pub fn saturating_duration_since(self, other: Self) -> DurationUs {
        DurationUs(self.0.saturating_sub(other.0))
    }

    #[inline]
    pub fn elapsed(self) -> anyhow::Result<DurationUs> {
        Self::now().duration_since(self)
    }

    #[inline]
    pub fn saturating_elapsed(self) -> DurationUs {
        Self::now().saturating_duration_since(self)
    }

    #[inline]
    pub fn saturating_add(self, duration: DurationUs) -> TimestampUs {
        TimestampUs(self.0.saturating_add(duration.0))
    }

    #[inline]
    pub fn saturating_sub(self, duration: DurationUs) -> TimestampUs {
        TimestampUs(self.0.saturating_sub(duration.0))
    }

    #[inline]
    pub fn is_multiple_of(self, duration: DurationUs) -> bool {
        match self.0.checked_rem(duration.0) {
            Some(rem) => rem == 0,
            None => true,
        }
    }

    #[inline]
    pub fn checked_add(self, duration: DurationUs) -> anyhow::Result<Self> {
        Ok(TimestampUs(
            self.0
                .checked_add(duration.0)
                .context("checked_add failed")?,
        ))
    }

    #[inline]
    pub fn checked_sub(self, duration: DurationUs) -> anyhow::Result<Self> {
        Ok(TimestampUs(
            self.0
                .checked_sub(duration.0)
                .context("checked_sub failed")?,
        ))
    }
}

impl TryFrom<SystemTime> for TimestampUs {
    type Error = anyhow::Error;

    fn try_from(value: SystemTime) -> Result<Self, Self::Error> {
        let value = value
            .duration_since(SystemTime::UNIX_EPOCH)
            .context("invalid system time")?
            .as_micros()
            .try_into()?;
        Ok(Self(value))
    }
}

impl TryFrom<TimestampUs> for SystemTime {
    type Error = anyhow::Error;

    fn try_from(value: TimestampUs) -> Result<Self, Self::Error> {
        SystemTime::UNIX_EPOCH
            .checked_add(Duration::from_micros(value.as_micros()))
            .context("checked_add failed")
    }
}

impl TryFrom<&chrono::DateTime<chrono::Utc>> for TimestampUs {
    type Error = anyhow::Error;

    #[inline]
    fn try_from(value: &chrono::DateTime<chrono::Utc>) -> Result<Self, Self::Error> {
        Ok(Self(value.timestamp_micros().try_into()?))
    }
}

impl TryFrom<chrono::DateTime<chrono::Utc>> for TimestampUs {
    type Error = anyhow::Error;

    #[inline]
    fn try_from(value: chrono::DateTime<chrono::Utc>) -> Result<Self, Self::Error> {
        TryFrom::<&chrono::DateTime<chrono::Utc>>::try_from(&value)
    }
}

impl TryFrom<TimestampUs> for chrono::DateTime<chrono::Utc> {
    type Error = anyhow::Error;

    #[inline]
    fn try_from(value: TimestampUs) -> Result<Self, Self::Error> {
        chrono::DateTime::<chrono::Utc>::from_timestamp_micros(value.as_micros().try_into()?)
            .with_context(|| format!("cannot convert timestamp to datetime: {value:?}"))
    }
}

/// Non-negative duration with microsecond resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct DurationUs(u64);

impl DurationUs {
    pub const ZERO: Self = Self(0);

    #[inline]
    pub const fn from_micros(micros: u64) -> Self {
        Self(micros)
    }

    #[inline]
    pub const fn as_micros(self) -> u64 {
        self.0
    }

    #[inline]
    pub fn as_nanos(self) -> u128 {
        // never overflows
        u128::from(self.0) * 1000
    }

    #[inline]
    pub fn as_nanos_i128(self) -> i128 {
        // never overflows
        i128::from(self.0) * 1000
    }

    #[inline]
    pub fn from_nanos(nanos: u128) -> anyhow::Result<Self> {
        let micros = nanos.checked_div(1000).context("checked_div failed")?;
        Ok(Self::from_micros(micros.try_into()?))
    }

    #[inline]
    pub fn as_millis(self) -> u64 {
        self.0 / 1000
    }

    #[inline]
    pub const fn from_millis_u32(millis: u32) -> Self {
        // never overflows
        Self((millis as u64) * 1_000)
    }

    #[inline]
    pub fn from_millis(millis: u64) -> anyhow::Result<Self> {
        let micros = millis
            .checked_mul(1000)
            .context("millis.checked_mul(1000) failed")?;
        Ok(Self::from_micros(micros))
    }

    #[inline]
    pub fn as_secs(self) -> u64 {
        self.0 / 1_000_000
    }

    #[inline]
    pub const fn from_secs_u32(secs: u32) -> Self {
        // never overflows
        Self((secs as u64) * 1_000_000)
    }

    #[inline]
    pub fn from_secs(secs: u64) -> anyhow::Result<Self> {
        let micros = secs
            .checked_mul(1_000_000)
            .context("secs.checked_mul(1_000_000) failed")?;
        Ok(Self::from_micros(micros))
    }

    #[inline]
    pub const fn from_days_u16(days: u16) -> Self {
        // never overflows
        Self((days as u64) * 24 * 3600 * 1_000_000)
    }

    #[inline]
    pub fn is_multiple_of(self, other: DurationUs) -> bool {
        match self.0.checked_rem(other.0) {
            Some(rem) => rem == 0,
            None => true,
        }
    }

    #[inline]
    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    #[inline]
    pub const fn is_positive(self) -> bool {
        self.0 > 0
    }

    #[inline]
    pub fn checked_add(self, other: DurationUs) -> anyhow::Result<Self> {
        Ok(DurationUs(
            self.0.checked_add(other.0).context("checked_add failed")?,
        ))
    }

    #[inline]
    pub fn checked_sub(self, other: DurationUs) -> anyhow::Result<Self> {
        Ok(DurationUs(
            self.0.checked_sub(other.0).context("checked_sub failed")?,
        ))
    }

    #[inline]
    pub fn checked_mul(self, n: u64) -> anyhow::Result<DurationUs> {
        Ok(DurationUs(
            self.0.checked_mul(n).context("checked_mul failed")?,
        ))
    }

    #[inline]
    pub fn checked_div(self, n: u64) -> anyhow::Result<DurationUs> {
        Ok(DurationUs(
            self.0.checked_div(n).context("checked_div failed")?,
        ))
    }
}

impl From<DurationUs> for Duration {
    #[inline]
    fn from(value: DurationUs) -> Self {
        Duration::from_micros(value.as_micros())
    }
}

impl TryFrom<Duration> for DurationUs {
    type Error = anyhow::Error;

    #[inline]
    fn try_from(value: Duration) -> Result<Self, Self::Error> {
        Ok(Self(value.as_micros().try_into()?))
    }
}

pub mod duration_us_serde_humantime {
    use std::time::Duration;

    use serde::{de::Error, Deserialize, Serialize};

    use crate::time::DurationUs;

    pub fn serialize<S>(value: &DurationUs, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        humantime_serde::Serde::from(Duration::from(*value)).serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<DurationUs, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = humantime_serde::Serde::<Duration>::deserialize(deserializer)?;
        value.into_inner().try_into().map_err(D::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FixedRate {
    rate: DurationUs,
}

impl FixedRate {
    pub const RATE_50_MS: Self = Self {
        rate: DurationUs::from_millis_u32(50),
    };
    pub const RATE_200_MS: Self = Self {
        rate: DurationUs::from_millis_u32(200),
    };
    pub const RATE_1000_MS: Self = Self {
        rate: DurationUs::from_millis_u32(1000),
    };

    // Assumptions (tested below):
    // - Values are sorted.
    // - 1 second contains a whole number of each interval.
    // - all intervals are divisable by the smallest interval.
    pub const ALL: [Self; 3] = [Self::RATE_50_MS, Self::RATE_200_MS, Self::RATE_1000_MS];
    pub const MIN: Self = Self::ALL[0];

    pub fn from_millis(millis: u32) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|v| v.rate.as_millis() == u64::from(millis))
    }

    pub fn duration(self) -> DurationUs {
        self.rate
    }
}

impl TryFrom<DurationUs> for FixedRate {
    type Error = anyhow::Error;

    fn try_from(value: DurationUs) -> Result<Self, Self::Error> {
        Self::ALL
            .into_iter()
            .find(|v| v.rate == value)
            .with_context(|| format!("unsupported rate: {value:?}"))
    }
}

impl From<FixedRate> for DurationUs {
    fn from(value: FixedRate) -> Self {
        value.rate
    }
}

#[test]
fn fixed_rate_values() {
    assert!(
        FixedRate::ALL.windows(2).all(|w| w[0] < w[1]),
        "values must be unique and sorted"
    );
    for value in FixedRate::ALL {
        assert_eq!(
            1_000_000 % value.duration().as_micros(),
            0,
            "1 s must contain whole number of intervals"
        );
        assert_eq!(
            value.duration().as_micros() % FixedRate::MIN.duration().as_micros(),
            0,
            "the interval's borders must be a subset of the minimal interval's borders"
        );
    }
}
