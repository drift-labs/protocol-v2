use {
    crate::router::Price,
    serde::{Deserialize, Deserializer, Serialize, Serializer},
    std::num::NonZeroI64,
};

pub fn serialize<S>(value: &Option<Price>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    value
        .map_or(0i64, |price| price.0.get())
        .serialize(serializer)
}

pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Price>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = i64::deserialize(deserializer)?;
    Ok(NonZeroI64::new(value).map(Price))
}
