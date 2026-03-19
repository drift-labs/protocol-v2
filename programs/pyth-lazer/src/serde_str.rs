pub mod option_price {
    use {
        crate::price::Price,
        serde::{de::Error, Deserialize, Deserializer, Serialize, Serializer},
        std::num::NonZeroI64,
    };

    pub fn serialize<S>(value: &Option<Price>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        value
            .map(|price| price.mantissa_i64().to_string())
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
            Ok(Some(Price::from_nonzero_mantissa(value)))
        } else {
            Ok(None)
        }
    }
}

pub mod timestamp {
    use {
        crate::time::TimestampUs,
        serde::{de::Error, Deserialize, Deserializer, Serialize, Serializer},
    };

    pub fn serialize<S>(value: &TimestampUs, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        value.as_micros().to_string().serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<TimestampUs, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let value: u64 = value.parse().map_err(D::Error::custom)?;
        Ok(TimestampUs::from_micros(value))
    }
}
