//! Types representing binary encoding of signable payloads and signature envelopes.

use {
    super::router::{PriceFeedId, PriceFeedProperty, TimestampUs},
    crate::router::{ChannelId, Price, Rate},
    anyhow::bail,
    byteorder::{ByteOrder, ReadBytesExt, WriteBytesExt, BE, LE},
    serde::{Deserialize, Serialize},
    std::{
        io::{Cursor, Read, Write},
        num::NonZeroI64,
    },
};

/// Data contained within a signable payload.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PayloadData {
    pub timestamp_us: TimestampUs,
    pub channel_id: ChannelId,
    // TODO: smallvec?
    pub feeds: Vec<PayloadFeedData>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PayloadFeedData {
    pub feed_id: PriceFeedId,
    // TODO: smallvec?
    pub properties: Vec<PayloadPropertyValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum PayloadPropertyValue {
    Price(Option<Price>),
    BestBidPrice(Option<Price>),
    BestAskPrice(Option<Price>),
    PublisherCount(u16),
    Exponent(i16),
    Confidence(Option<Price>),
    FundingRate(Option<Rate>),
    FundingTimestamp(Option<TimestampUs>),
    FeedUpdateTimestamp(Option<TimestampUs>),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AggregatedPriceFeedData {
    pub price: Option<Price>,
    pub best_bid_price: Option<Price>,
    pub best_ask_price: Option<Price>,
    pub publisher_count: u16,
    pub confidence: Option<Price>,
    pub funding_rate: Option<Rate>,
    pub funding_timestamp: Option<TimestampUs>,
}

/// First bytes of a payload's encoding
/// (in LE or BE depending on the byte order used for encoding the rest of the payload)
pub const PAYLOAD_FORMAT_MAGIC: u32 = 2479346549;

impl PayloadData {
    pub fn new(
        timestamp_us: TimestampUs,
        channel_id: ChannelId,
        feeds: &[(PriceFeedId, i16, AggregatedPriceFeedData)],
        requested_properties: &[PriceFeedProperty],
    ) -> Self {
        Self {
            timestamp_us,
            channel_id,
            feeds: feeds
                .iter()
                .map(|(feed_id, exponent, feed)| PayloadFeedData {
                    feed_id: *feed_id,
                    properties: requested_properties
                        .iter()
                        .map(|property| match property {
                            PriceFeedProperty::Price => PayloadPropertyValue::Price(feed.price),
                            PriceFeedProperty::BestBidPrice => {
                                PayloadPropertyValue::BestBidPrice(feed.best_bid_price)
                            }
                            PriceFeedProperty::BestAskPrice => {
                                PayloadPropertyValue::BestAskPrice(feed.best_ask_price)
                            }
                            PriceFeedProperty::PublisherCount => {
                                PayloadPropertyValue::PublisherCount(feed.publisher_count)
                            }
                            PriceFeedProperty::Exponent => {
                                PayloadPropertyValue::Exponent(*exponent)
                            }
                            PriceFeedProperty::Confidence => {
                                PayloadPropertyValue::Confidence(feed.confidence)
                            }
                            PriceFeedProperty::FundingRate => {
                                PayloadPropertyValue::FundingRate(feed.funding_rate)
                            }
                            PriceFeedProperty::FundingTimestamp => {
                                PayloadPropertyValue::FundingTimestamp(feed.funding_timestamp)
                            }
                            PriceFeedProperty::FundingRateInterval
                            | PriceFeedProperty::MarketSession
                            | PriceFeedProperty::EmaPrice
                            | PriceFeedProperty::EmaConfidence
                            | PriceFeedProperty::FeedUpdateTimestamp => {
                                PayloadPropertyValue::FeedUpdateTimestamp(feed.funding_timestamp)
                            }
                        })
                        .collect(),
                })
                .collect(),
        }
    }

    pub fn serialize<BO: ByteOrder>(&self, mut writer: impl Write) -> anyhow::Result<()> {
        writer.write_u32::<BO>(PAYLOAD_FORMAT_MAGIC)?;
        writer.write_u64::<BO>(self.timestamp_us.0)?;
        writer.write_u8(self.channel_id.0)?;
        writer.write_u8(self.feeds.len().try_into()?)?;
        for feed in &self.feeds {
            writer.write_u32::<BO>(feed.feed_id.0)?;
            writer.write_u8(feed.properties.len().try_into()?)?;
            for property in &feed.properties {
                match property {
                    PayloadPropertyValue::Price(price) => {
                        writer.write_u8(PriceFeedProperty::Price as u8)?;
                        write_option_price::<BO>(&mut writer, *price)?;
                    }
                    PayloadPropertyValue::BestBidPrice(price) => {
                        writer.write_u8(PriceFeedProperty::BestBidPrice as u8)?;
                        write_option_price::<BO>(&mut writer, *price)?;
                    }
                    PayloadPropertyValue::BestAskPrice(price) => {
                        writer.write_u8(PriceFeedProperty::BestAskPrice as u8)?;
                        write_option_price::<BO>(&mut writer, *price)?;
                    }
                    PayloadPropertyValue::PublisherCount(count) => {
                        writer.write_u8(PriceFeedProperty::PublisherCount as u8)?;
                        writer.write_u16::<BO>(*count)?;
                    }
                    PayloadPropertyValue::Exponent(exponent) => {
                        writer.write_u8(PriceFeedProperty::Exponent as u8)?;
                        writer.write_i16::<BO>(*exponent)?;
                    }
                    PayloadPropertyValue::Confidence(confidence) => {
                        writer.write_u8(PriceFeedProperty::Confidence as u8)?;
                        write_option_price::<BO>(&mut writer, *confidence)?;
                    }
                    PayloadPropertyValue::FundingRate(rate) => {
                        writer.write_u8(PriceFeedProperty::FundingRate as u8)?;
                        write_option_rate::<BO>(&mut writer, *rate)?;
                    }
                    PayloadPropertyValue::FundingTimestamp(timestamp) => {
                        writer.write_u8(PriceFeedProperty::FundingTimestamp as u8)?;
                        write_option_timestamp::<BO>(&mut writer, *timestamp)?;
                    }
                    PayloadPropertyValue::FeedUpdateTimestamp(timestamp) => {
                        writer.write_u8(PriceFeedProperty::FeedUpdateTimestamp as u8)?;
                        write_option_timestamp::<BO>(&mut writer, *timestamp)?;
                    }
                }
            }
        }
        Ok(())
    }

    pub fn deserialize_slice_le(data: &[u8]) -> anyhow::Result<Self> {
        Self::deserialize::<LE>(Cursor::new(data))
    }

    pub fn deserialize_slice_be(data: &[u8]) -> anyhow::Result<Self> {
        Self::deserialize::<BE>(Cursor::new(data))
    }

    pub fn deserialize<BO: ByteOrder>(mut reader: impl Read) -> anyhow::Result<Self> {
        let magic = reader.read_u32::<BO>()?;
        if magic != PAYLOAD_FORMAT_MAGIC {
            bail!("magic mismatch");
        }
        let timestamp_us = TimestampUs(reader.read_u64::<BO>()?);
        let channel_id = ChannelId(reader.read_u8()?);
        let num_feeds = reader.read_u8()?;
        let mut feeds = Vec::with_capacity(num_feeds.into());
        for _ in 0..num_feeds {
            let feed_id = PriceFeedId(reader.read_u32::<BO>()?);
            let num_properties = reader.read_u8()?;
            let mut feed = PayloadFeedData {
                feed_id,
                properties: Vec::with_capacity(num_properties.into()),
            };
            for _ in 0..num_properties {
                let property = reader.read_u8()?;
                let value = if property == PriceFeedProperty::Price as u8 {
                    PayloadPropertyValue::Price(read_option_price::<BO>(&mut reader)?)
                } else if property == PriceFeedProperty::BestBidPrice as u8 {
                    PayloadPropertyValue::BestBidPrice(read_option_price::<BO>(&mut reader)?)
                } else if property == PriceFeedProperty::BestAskPrice as u8 {
                    PayloadPropertyValue::BestAskPrice(read_option_price::<BO>(&mut reader)?)
                } else if property == PriceFeedProperty::PublisherCount as u8 {
                    PayloadPropertyValue::PublisherCount(reader.read_u16::<BO>()?)
                } else if property == PriceFeedProperty::Exponent as u8 {
                    PayloadPropertyValue::Exponent(reader.read_i16::<BO>()?)
                } else if property == PriceFeedProperty::Confidence as u8 {
                    PayloadPropertyValue::Confidence(read_option_price::<BO>(&mut reader)?)
                } else if property == PriceFeedProperty::FundingRate as u8 {
                    PayloadPropertyValue::FundingRate(read_option_rate::<BO>(&mut reader)?)
                } else if property == PriceFeedProperty::FundingTimestamp as u8 {
                    PayloadPropertyValue::FundingTimestamp(read_option_timestamp::<BO>(
                        &mut reader,
                    )?)
                } else if property == PriceFeedProperty::FeedUpdateTimestamp as u8 {
                    PayloadPropertyValue::FeedUpdateTimestamp(read_option_timestamp::<BO>(
                        &mut reader,
                    )?)
                } else {
                    bail!("unknown property: {property}");
                };
                feed.properties.push(value);
            }
            feeds.push(feed);
        }
        Ok(Self {
            timestamp_us,
            channel_id,
            feeds,
        })
    }
}

fn write_option_price<BO: ByteOrder>(
    mut writer: impl Write,
    value: Option<Price>,
) -> std::io::Result<()> {
    writer.write_i64::<BO>(value.map_or(0, |v| v.0.get()))
}

fn read_option_price<BO: ByteOrder>(mut reader: impl Read) -> std::io::Result<Option<Price>> {
    let value = NonZeroI64::new(reader.read_i64::<BO>()?);
    Ok(value.map(Price))
}

fn write_option_rate<BO: ByteOrder>(
    mut writer: impl Write,
    value: Option<Rate>,
) -> std::io::Result<()> {
    match value {
        Some(value) => {
            writer.write_u8(1)?;
            writer.write_i64::<BO>(value.0)
        }
        None => {
            writer.write_u8(0)?;
            Ok(())
        }
    }
}

fn read_option_rate<BO: ByteOrder>(mut reader: impl Read) -> std::io::Result<Option<Rate>> {
    let present = reader.read_u8()? != 0;
    if present {
        Ok(Some(Rate(reader.read_i64::<BO>()?)))
    } else {
        Ok(None)
    }
}

fn write_option_timestamp<BO: ByteOrder>(
    mut writer: impl Write,
    value: Option<TimestampUs>,
) -> std::io::Result<()> {
    match value {
        Some(value) => {
            writer.write_u8(1)?;
            writer.write_u64::<BO>(value.0)
        }
        None => {
            writer.write_u8(0)?;
            Ok(())
        }
    }
}

fn read_option_timestamp<BO: ByteOrder>(
    mut reader: impl Read,
) -> std::io::Result<Option<TimestampUs>> {
    let present = reader.read_u8()? != 0;
    if present {
        Ok(Some(TimestampUs(reader.read_u64::<BO>()?)))
    } else {
        Ok(None)
    }
}
