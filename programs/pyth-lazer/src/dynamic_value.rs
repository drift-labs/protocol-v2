use std::collections::BTreeMap;

use crate::time::{DurationUs, TimestampUs};
use anyhow::bail;
use derive_more::From;
use serde::{
    ser::{SerializeMap, SerializeSeq},
    Serialize,
};

#[derive(Debug, Clone, PartialEq, From)]
pub enum DynamicValue {
    String(String),
    F64(f64),
    U64(u64),
    I64(i64),
    Bool(bool),
    Timestamp(TimestampUs),
    Duration(DurationUs),
    Bytes(Vec<u8>),
    List(Vec<DynamicValue>),
    Map(BTreeMap<String, DynamicValue>),
}

impl Serialize for DynamicValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            DynamicValue::String(v) => serializer.serialize_str(v),
            DynamicValue::F64(v) => serializer.serialize_f64(*v),
            DynamicValue::U64(v) => serializer.serialize_u64(*v),
            DynamicValue::I64(v) => serializer.serialize_i64(*v),
            DynamicValue::Bool(v) => serializer.serialize_bool(*v),
            DynamicValue::Timestamp(v) => serializer.serialize_u64(v.as_micros()),
            DynamicValue::Duration(v) => {
                serializer.serialize_str(&humantime::format_duration((*v).into()).to_string())
            }
            DynamicValue::Bytes(v) => serializer.serialize_str(&hex::encode(v)),
            DynamicValue::List(v) => {
                let mut seq_serializer = serializer.serialize_seq(Some(v.len()))?;
                for element in v {
                    seq_serializer.serialize_element(element)?;
                }
                seq_serializer.end()
            }
            DynamicValue::Map(map) => {
                let mut map_serializer = serializer.serialize_map(Some(map.len()))?;
                for (k, v) in map {
                    map_serializer.serialize_entry(k, v)?;
                }
                map_serializer.end()
            }
        }
    }
}

impl DynamicValue {
    pub fn is_str(&self, field_name: &str) -> anyhow::Result<()> {
        match self {
            DynamicValue::String(_) => Ok(()),
            _ => bail!("invalid value type for {field_name}: expected String, got {self:?}"),
        }
    }
}
