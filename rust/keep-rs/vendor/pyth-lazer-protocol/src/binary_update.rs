use {
    crate::{message::Message, subscription::SubscriptionId},
    anyhow::{bail, Context},
    byteorder::{WriteBytesExt, BE, LE},
};

/// First bytes (LE) of a binary Websocket message. A binary message will
/// contain one or multiple price updates, each with its encoding format magic.
pub const BINARY_UPDATE_FORMAT_MAGIC: u32 = 461928307;

/// Content of a Websocket update sent to the client when the binary delivery method
/// is requested.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BinaryWsUpdate {
    pub subscription_id: SubscriptionId,
    pub messages: Vec<Message>,
}

impl BinaryWsUpdate {
    pub fn serialize(&self, buf: &mut Vec<u8>) -> anyhow::Result<()> {
        buf.write_u32::<LE>(BINARY_UPDATE_FORMAT_MAGIC)?;
        buf.write_u64::<BE>(self.subscription_id.0)?;

        for message in &self.messages {
            write_with_len_header(buf, |buf| message.serialize(buf))?;
        }
        Ok(())
    }

    pub fn deserialize_slice(data: &[u8]) -> anyhow::Result<Self> {
        let mut pos = 0;
        let magic = u32::from_le_bytes(
            data.get(pos..pos + 4)
                .context("data too short")?
                .try_into()?,
        );
        pos += 4;

        if magic != BINARY_UPDATE_FORMAT_MAGIC {
            bail!("binary update format magic mismatch");
        }

        let subscription_id = SubscriptionId(u64::from_be_bytes(
            data.get(pos..pos + 8)
                .context("data too short")?
                .try_into()?,
        ));
        pos += 8;

        let mut messages = Vec::new();

        while pos < data.len() {
            let len: usize = u16::from_be_bytes(
                data.get(pos..pos + 2)
                    .context("data too short")?
                    .try_into()?,
            )
            .into();
            pos += 2;
            let message_data = data.get(pos..pos + len).context("data too short")?;
            pos += len;
            messages.push(Message::deserialize_slice(message_data)?);
        }

        Ok(Self {
            subscription_id,
            messages,
        })
    }
}

/// Performs write operations specified by `f` and inserts the length header before them.
/// The length is written as a BE u16.
fn write_with_len_header(
    out: &mut Vec<u8>,
    f: impl FnOnce(&mut Vec<u8>) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let len_index = out.len();
    // Make space for size.
    out.push(0);
    out.push(0);
    let data_start_index = out.len();
    f(out)?;
    let len = out.len() - data_start_index;
    let len: u16 = len.try_into()?;
    out[len_index..data_start_index].copy_from_slice(&len.to_be_bytes());

    Ok(())
}
