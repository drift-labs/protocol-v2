use {
    anyhow::bail,
    byteorder::{ReadBytesExt, LE},
    pyth_lazer_protocol::{
        message::{
            format_magics_le::{EVM_FORMAT_MAGIC, SOLANA_FORMAT_MAGIC},
            EvmMessage, SolanaMessage,
        },
        payload::PayloadData,
    },
    std::io::{stdin, BufRead, Cursor},
};

fn main() -> anyhow::Result<()> {
    println!("Reading hex encoded payloads from stdin...");
    for line in stdin().lock().lines() {
        let message = hex::decode(line?.trim())?;
        let magic = Cursor::new(&message).read_u32::<LE>()?;
        if magic == SOLANA_FORMAT_MAGIC {
            println!("this is a solana payload");
            let message = SolanaMessage::deserialize_slice(&message)?;
            println!(
                "solana public key: {}",
                bs58::encode(&message.public_key).into_string()
            );
            let key = ed25519_dalek::VerifyingKey::from_bytes(&message.public_key)?;
            key.verify_strict(
                &message.payload,
                &ed25519_dalek::Signature::from_bytes(&message.signature),
            )?;
            println!("signature is valid");
            let payload = PayloadData::deserialize_slice_le(&message.payload)?;
            println!("payload: {payload:#?}");
        } else if magic == EVM_FORMAT_MAGIC {
            println!("this is an evm payload");
            let message = EvmMessage::deserialize_slice(&message)?;
            let public_key = libsecp256k1::recover(
                &libsecp256k1::Message::parse(&alloy_primitives::keccak256(&message.payload)),
                &libsecp256k1::Signature::parse_standard(&message.signature)?,
                &libsecp256k1::RecoveryId::parse(message.recovery_id)?,
            )?;
            println!(
                "evm address recovered from signature: {:?}",
                hex::encode(&alloy_primitives::keccak256(&public_key.serialize()[1..])[12..])
            );
            let payload = PayloadData::deserialize_slice_be(&message.payload)?;
            println!("payload: {payload:#?}");
        } else {
            bail!("unknown format");
        }
    }

    Ok(())
}
