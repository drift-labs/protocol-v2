pub mod option_price {
    use {
        crate::router::Price,
        serde::{de::Error, Deserialize, Deserializer, Serialize, Serializer},
        std::num::NonZeroI64,
    };

    pub fn serialize<S>(value: &Option<Price>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        value
            .map(|price| price.0.get().to_string())
            .serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Price>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Option::<&str>::deserialize(deserializer)?;
        if let Some(value) = value {
            let value: i64 = value.parse().map_err(D::Error::custom)?;
            let value = NonZeroI64::new(value).ok_or_else(|| D::Error::custom("zero price"))?;
            Ok(Some(Price(value)))
        } else {
            Ok(None)
        }
    }
}

pub mod timestamp {
    use {
        crate::router::TimestampUs,
        serde::{de::Error, Deserialize, Deserializer, Serialize, Serializer},
    };

    pub fn serialize<S>(value: &TimestampUs, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        value.0.to_string().serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<TimestampUs, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = <&str>::deserialize(deserializer)?;
        let value: u64 = value.parse().map_err(D::Error::custom)?;
        Ok(TimestampUs(value))
    }
}
