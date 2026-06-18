use {
    self::format_magics_le::{EVM_FORMAT_MAGIC, SOLANA_FORMAT_MAGIC},
    crate::router::ParsedPayload,
    anyhow::{bail, Context},
    byteorder::{ByteOrder, ReadBytesExt, WriteBytesExt, BE, LE},
    derive_more::From,
    format_magics_le::{JSON_FORMAT_MAGIC, LE_ECDSA_FORMAT_MAGIC, LE_UNSIGNED_FORMAT_MAGIC},
    std::io::{Cursor, Read, Write},
};

/// Constants containing first bytes (LE) of a price update.
pub mod format_magics_le {
    /// First bytes (LE) of a JSON-encoded price update (JSON structure is represented by
    /// `router::ParsedPayload` type).
    ///
    /// Note: this header will only be present if the binary delivery method is requested
    /// in a Websocket subscription. If the default (JSON) delivery method is used,
    /// the price update JSON will simply be embedded in the main JSON of the notification.
    pub const JSON_FORMAT_MAGIC: u32 = 3302625434;
    /// First bytes (LE) of an EVM-targeted price update (BE-encoded payload with an ECDSA signature).
    pub const EVM_FORMAT_MAGIC: u32 = 2593727018;
    /// First bytes (LE) of a Solana-targeted price update with a native Solana signature
    /// (LE-encoded payload with a Ed25519 signature).
    pub const SOLANA_FORMAT_MAGIC: u32 = 2182742457;
    /// First bytes (LE) of a price update with LE-encoded payload and an ECDSA signature
    /// (suitable for Solana).
    pub const LE_ECDSA_FORMAT_MAGIC: u32 = 1296547300;
    /// First bytes (LE) of a price update with LE-encoded payload without a signature
    /// (suitable for off-chain usage).
    pub const LE_UNSIGNED_FORMAT_MAGIC: u32 = 1499680012;
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, From)]
pub enum Message {
    Evm(EvmMessage),
    Solana(SolanaMessage),
    LeEcdsa(LeEcdsaMessage),
    LeUnsigned(LeUnsignedMessage),
    Json(ParsedPayload),
}

impl Message {
    pub fn serialize(&self, mut writer: impl Write) -> anyhow::Result<()> {
        match self {
            Message::Evm(message) => message.serialize(writer),
            Message::Solana(message) => message.serialize(writer),
            Message::LeEcdsa(message) => message.serialize(writer),
            Message::LeUnsigned(message) => message.serialize(writer),
            Message::Json(message) => {
                writer.write_u32::<LE>(JSON_FORMAT_MAGIC)?;
                serde_json::to_writer(writer, message)?;
                Ok(())
            }
        }
    }

    pub fn deserialize_slice(data: &[u8]) -> anyhow::Result<Self> {
        let magic = LE::read_u32(data.get(0..4).context("data too short")?);
        match magic {
            JSON_FORMAT_MAGIC => Ok(serde_json::from_slice::<ParsedPayload>(&data[4..])?.into()),
            EVM_FORMAT_MAGIC => Ok(EvmMessage::deserialize_slice(data)?.into()),
            SOLANA_FORMAT_MAGIC => Ok(SolanaMessage::deserialize_slice(data)?.into()),
            LE_ECDSA_FORMAT_MAGIC => Ok(LeEcdsaMessage::deserialize_slice(data)?.into()),
            LE_UNSIGNED_FORMAT_MAGIC => Ok(LeUnsignedMessage::deserialize_slice(data)?.into()),
            _ => bail!("unrecognized format magic"),
        }
    }
}

/// EVM signature enveope.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EvmMessage {
    pub payload: Vec<u8>,
    pub signature: [u8; 64],
    pub recovery_id: u8,
}

impl EvmMessage {
    pub fn serialize(&self, mut writer: impl Write) -> anyhow::Result<()> {
        writer.write_u32::<LE>(EVM_FORMAT_MAGIC)?;
        writer.write_all(&self.signature)?;
        writer.write_u8(self.recovery_id)?;
        writer.write_u16::<BE>(self.payload.len().try_into()?)?;
        writer.write_all(&self.payload)?;
        Ok(())
    }

    pub fn deserialize_slice(data: &[u8]) -> anyhow::Result<Self> {
        Self::deserialize(Cursor::new(data))
    }

    pub fn deserialize(mut reader: impl Read) -> anyhow::Result<Self> {
        let magic = reader.read_u32::<LE>()?;
        if magic != EVM_FORMAT_MAGIC {
            bail!("magic mismatch");
        }
        let mut signature = [0u8; 64];
        reader.read_exact(&mut signature)?;
        let recovery_id = reader.read_u8()?;
        let payload_len: usize = reader.read_u16::<BE>()?.into();
        let mut payload = vec![0u8; payload_len];
        reader.read_exact(&mut payload)?;
        Ok(Self {
            payload,
            signature,
            recovery_id,
        })
    }
}

/// Solana signature envelope.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SolanaMessage {
    pub payload: Vec<u8>,
    pub signature: [u8; 64],
    pub public_key: [u8; 32],
}

impl SolanaMessage {
    pub fn serialize(&self, mut writer: impl Write) -> anyhow::Result<()> {
        writer.write_u32::<LE>(SOLANA_FORMAT_MAGIC)?;
        writer.write_all(&self.signature)?;
        writer.write_all(&self.public_key)?;
        writer.write_u16::<LE>(self.payload.len().try_into()?)?;
        writer.write_all(&self.payload)?;
        Ok(())
    }

    pub fn deserialize_slice(data: &[u8]) -> anyhow::Result<Self> {
        Self::deserialize(Cursor::new(data))
    }

    pub fn deserialize(mut reader: impl Read) -> anyhow::Result<Self> {
        let magic = reader.read_u32::<LE>()?;
        if magic != SOLANA_FORMAT_MAGIC {
            bail!("magic mismatch");
        }
        let mut signature = [0u8; 64];
        reader.read_exact(&mut signature)?;
        let mut public_key = [0u8; 32];
        reader.read_exact(&mut public_key)?;
        let payload_len: usize = reader.read_u16::<LE>()?.into();
        let mut payload = vec![0u8; payload_len];
        reader.read_exact(&mut payload)?;
        Ok(Self {
            payload,
            signature,
            public_key,
        })
    }
}

/// LE-ECDSA format enveope.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LeEcdsaMessage {
    pub payload: Vec<u8>,
    pub signature: [u8; 64],
    pub recovery_id: u8,
}

impl LeEcdsaMessage {
    pub fn serialize(&self, mut writer: impl Write) -> anyhow::Result<()> {
        writer.write_u32::<LE>(LE_ECDSA_FORMAT_MAGIC)?;
        writer.write_all(&self.signature)?;
        writer.write_u8(self.recovery_id)?;
        writer.write_u16::<LE>(self.payload.len().try_into()?)?;
        writer.write_all(&self.payload)?;
        Ok(())
    }

    pub fn deserialize_slice(data: &[u8]) -> anyhow::Result<Self> {
        Self::deserialize(Cursor::new(data))
    }

    pub fn deserialize(mut reader: impl Read) -> anyhow::Result<Self> {
        let magic = reader.read_u32::<LE>()?;
        if magic != LE_ECDSA_FORMAT_MAGIC {
            bail!("magic mismatch");
        }
        let mut signature = [0u8; 64];
        reader.read_exact(&mut signature)?;
        let recovery_id = reader.read_u8()?;
        let payload_len: usize = reader.read_u16::<LE>()?.into();
        let mut payload = vec![0u8; payload_len];
        reader.read_exact(&mut payload)?;
        Ok(Self {
            payload,
            signature,
            recovery_id,
        })
    }
}

/// LE-Unsigned format enveope.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LeUnsignedMessage {
    pub payload: Vec<u8>,
}

impl LeUnsignedMessage {
    pub fn serialize(&self, mut writer: impl Write) -> anyhow::Result<()> {
        writer.write_u32::<LE>(LE_UNSIGNED_FORMAT_MAGIC)?;
        writer.write_u16::<LE>(self.payload.len().try_into()?)?;
        writer.write_all(&self.payload)?;
        Ok(())
    }

    pub fn deserialize_slice(data: &[u8]) -> anyhow::Result<Self> {
        Self::deserialize(Cursor::new(data))
    }

    pub fn deserialize(mut reader: impl Read) -> anyhow::Result<Self> {
        let magic = reader.read_u32::<LE>()?;
        if magic != LE_UNSIGNED_FORMAT_MAGIC {
            bail!("magic mismatch");
        }
        let payload_len: usize = reader.read_u16::<LE>()?.into();
        let mut payload = vec![0u8; payload_len];
        reader.read_exact(&mut payload)?;
        Ok(Self { payload })
    }
}

#[test]
fn test_evm_serde() {
    let m1 = EvmMessage {
        payload: vec![1, 2, 4, 3],
        signature: [5; 64],
        recovery_id: 1,
    };
    let mut buf = Vec::new();
    m1.serialize(&mut buf).unwrap();
    assert_eq!(m1, EvmMessage::deserialize_slice(&buf).unwrap());
}

#[test]
fn test_solana_serde() {
    let m1 = SolanaMessage {
        payload: vec![1, 2, 4, 3],
        signature: [5; 64],
        public_key: [6; 32],
    };
    let mut buf = Vec::new();
    m1.serialize(&mut buf).unwrap();
    assert_eq!(m1, SolanaMessage::deserialize_slice(&buf).unwrap());
}

#[test]
fn test_le_ecdsa_serde() {
    let m1 = LeEcdsaMessage {
        payload: vec![1, 2, 4, 3],
        signature: [5; 64],
        recovery_id: 1,
    };
    let mut buf = Vec::new();
    m1.serialize(&mut buf).unwrap();
    assert_eq!(m1, LeEcdsaMessage::deserialize_slice(&buf).unwrap());
}

#[test]
fn test_le_unsigned_serde() {
    let m1 = LeUnsignedMessage {
        payload: vec![1, 2, 4, 3],
    };
    let mut buf = Vec::new();
    m1.serialize(&mut buf).unwrap();
    assert_eq!(m1, LeUnsignedMessage::deserialize_slice(&buf).unwrap());
}
