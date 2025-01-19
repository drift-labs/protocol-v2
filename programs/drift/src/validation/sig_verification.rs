use crate::error::ErrorCode;
use crate::state::order_params::SwiftOrderParamsMessage;
use anchor_lang::prelude::*;
use bytemuck::try_cast_slice;
use bytemuck::{Pod, Zeroable};
use byteorder::ByteOrder;
use byteorder::LE;
use solana_program::ed25519_program::ID as ED25519_ID;
use solana_program::instruction::Instruction;
use std::convert::TryInto;

const ED25519_PROGRAM_INPUT_HEADER_LEN: usize = 2;

const SIGNATURE_LEN: u16 = 64;
const PUBKEY_LEN: u16 = 32;
const MESSAGE_SIZE_LEN: u16 = 2;

/// Part of the inputs to the built-in `ed25519_program` on Solana that represents a single
/// signature verification request.
///
/// `ed25519_program` does not receive the signature data directly. Instead, it receives
/// these fields that indicate the location of the signature data within data of other
/// instructions within the same transaction.
#[derive(Debug, Clone, Copy, Zeroable, Pod)]
#[repr(C)]
pub struct Ed25519SignatureOffsets {
    /// Offset to the ed25519 signature within the instruction data.
    pub signature_offset: u16,
    /// Index of the instruction that contains the signature.
    pub signature_instruction_index: u16,
    /// Offset to the public key within the instruction data.
    pub public_key_offset: u16,
    /// Index of the instruction that contains the public key.
    pub public_key_instruction_index: u16,
    /// Offset to the signed payload within the instruction data.
    pub message_data_offset: u16,
    // Size of the signed payload.
    pub message_data_size: u16,
    /// Index of the instruction that contains the signed payload.
    pub message_instruction_index: u16,
}

/// Verify Ed25519Program instruction fields
pub fn verify_ed25519_ix(ix: &Instruction, pubkey: &[u8], msg: &[u8], sig: &[u8]) -> Result<()> {
    if ix.program_id       != ED25519_ID                   ||  // The program id we expect
        ix.accounts.len()   != 0                            ||  // With no context accounts
        ix.data.len()       != (16 + 64 + 32 + msg.len())
    // And data of this size
    {
        msg!("Ix not present: program ID: {:?}", ix.program_id);
        msg!("Ix not present: accounts: {:?}", ix.accounts.len());
        msg!(
            "Ix not present: data: {:?}, len: {:?}",
            ix.data.len(),
            16 + 64 + 32 + msg.len()
        );
        return Err(ErrorCode::SigVerificationFailed.into()); // Otherwise, we can already throw err
    }

    check_ed25519_data(&ix.data, pubkey, msg, sig)?; // If that's not the case, check data

    Ok(())
}

/// Verify serialized Ed25519Program instruction data
fn check_ed25519_data(data: &[u8], pubkey: &[u8], msg: &[u8], sig: &[u8]) -> Result<()> {
    // According to this layout used by the Ed25519Program
    // https://github.com/solana-labs/solana-web3.js/blob/master/src/ed25519-program.ts#L33

    // "Deserializing" byte slices
    let num_signatures = &[data[0]]; // Byte  0
    let padding = &[data[1]]; // Byte  1
    let signature_offset = &data[2..=3]; // Bytes 2,3
    let signature_instruction_index = &data[4..=5]; // Bytes 4,5
    let public_key_offset = &data[6..=7]; // Bytes 6,7
    let public_key_instruction_index = &data[8..=9]; // Bytes 8,9
    let message_data_offset = &data[10..=11]; // Bytes 10,11
    let message_data_size = &data[12..=13]; // Bytes 12,13
    let message_instruction_index = &data[14..=15]; // Bytes 14,15

    let data_pubkey = &data[16..16 + 32]; // Bytes 16..16+32
    let data_sig = &data[48..48 + 64]; // Bytes 48..48+64
    let data_msg = &data[112..]; // Bytes 112..end

    // Expected values
    let exp_public_key_offset: u16 = 16; // 2*u8 + 7*u16
    let exp_signature_offset: u16 = exp_public_key_offset + pubkey.len() as u16;
    let exp_message_data_offset: u16 = exp_signature_offset + sig.len() as u16;
    let exp_num_signatures: u8 = 1;
    let exp_message_data_size: u16 = msg.len().try_into().unwrap();

    // Header and Arg Checks

    // Header
    if num_signatures != &exp_num_signatures.to_le_bytes()
        || padding != &[0]
        || signature_offset != &exp_signature_offset.to_le_bytes()
        || signature_instruction_index != &u16::MAX.to_le_bytes()
        || public_key_offset != &exp_public_key_offset.to_le_bytes()
        || public_key_instruction_index != &u16::MAX.to_le_bytes()
        || message_data_offset != &exp_message_data_offset.to_le_bytes()
        || message_data_size != &exp_message_data_size.to_le_bytes()
        || message_instruction_index != &u16::MAX.to_le_bytes()
    {
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    // Arguments
    if data_pubkey != pubkey || data_msg != msg || data_sig != sig {
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    Ok(())
}

pub struct VerifiedMessage {
    pub swift_order_params_message: SwiftOrderParamsMessage,
    pub signature: [u8; 64],
}

/// Check Ed25519Program instruction data verifies the given msg
///
/// `ix` an Ed25519Program instruction [see](https://github.com/solana-labs/solana/blob/master/sdk/src/ed25519_instruction.rs))
///
/// `msg` expected msg signed by the offchain client e.g 'sha256(appMessage.serialize())' for a digest
///
/// `pubkey` expected pubkey of the signer
///
pub fn verify_ed25519_msg(
    ix: &Instruction,
    current_ix_index: u16,
    signer: &[u8; 32],
    msg: &[u8],
    message_offset: u16,
) -> Result<VerifiedMessage> {
    if ix.program_id != ED25519_ID || ix.accounts.len() != 0 {
        msg!("Invalid Ix: program ID: {:?}", ix.program_id);
        msg!("Invalid Ix: accounts: {:?}", ix.accounts.len());
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    let ix_data = &ix.data;
    // According to this layout used by the Ed25519Program]
    if ix_data.len() < 2 {
        msg!(
            "Invalid Ix, should be header len = 2. data: {:?}",
            ix.data.len(),
        );
        return Err(SignatureVerificationError::InvalidEd25519InstructionDataLength.into());
    }

    // Parse the ix data into the offsets
    let args: &[Ed25519SignatureOffsets] =
        try_cast_slice(&ix_data[ED25519_PROGRAM_INPUT_HEADER_LEN..]).map_err(|_| {
            msg!("Invalid Ix: failed to cast slice");
            ErrorCode::SigVerificationFailed
        })?;

    let offsets = &args[0];
    if offsets.signature_offset != message_offset {
        msg!(
            "Invalid Ix: signature offset: {:?}",
            offsets.signature_offset
        );
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    let expected_public_key_offset = message_offset
        .checked_add(SIGNATURE_LEN)
        .ok_or(ErrorCode::SigVerificationFailed)?;
    if offsets.public_key_offset != expected_public_key_offset {
        msg!(
            "Invalid Ix: public key offset: {:?}, expected: {:?}",
            offsets.public_key_offset,
            expected_public_key_offset
        );
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    let expected_message_size_offset = expected_public_key_offset
        .checked_add(PUBKEY_LEN)
        .ok_or(ErrorCode::SigVerificationFailed)?;

    let expected_message_data_offset = expected_message_size_offset
        .checked_add(MESSAGE_SIZE_LEN)
        .ok_or(SignatureVerificationError::MessageOffsetOverflow)?;
    if offsets.message_data_offset != expected_message_data_offset {
        return Err(SignatureVerificationError::InvalidMessageOffset.into());
    }

    let expected_message_size: u16 = {
        let start = usize::from(
            expected_message_size_offset
                .checked_sub(message_offset)
                .unwrap(),
        );
        let end = usize::from(
            expected_message_data_offset
                .checked_sub(message_offset)
                .unwrap(),
        );
        LE::read_u16(&msg[start..end])
    };
    if offsets.message_data_size != expected_message_size {
        return Err(SignatureVerificationError::InvalidMessageDataSize.into());
    }
    if offsets.signature_instruction_index != current_ix_index
        || offsets.public_key_instruction_index != current_ix_index
        || offsets.message_instruction_index != current_ix_index
    {
        return Err(SignatureVerificationError::InvalidInstructionIndex.into());
    }

    let public_key = {
        let start = usize::from(
            expected_public_key_offset
                .checked_sub(message_offset)
                .unwrap(),
        );
        let end = start
            .checked_add(anchor_lang::solana_program::pubkey::PUBKEY_BYTES)
            .ok_or(SignatureVerificationError::MessageOffsetOverflow)?;
        &msg[start..end]
    };
    let payload = {
        let start = usize::from(
            expected_message_data_offset
                .checked_sub(message_offset)
                .unwrap(),
        );
        let end = start
            .checked_add(expected_message_size.into())
            .ok_or(SignatureVerificationError::MessageOffsetOverflow)?;
        &msg[start..end]
    };

    if public_key != signer {
        msg!("Invalid Ix: message signed by: {:?}", public_key);
        msg!("Invalid Ix: expected pubkey: {:?}", signer);
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    let signature = {
        let start = usize::from(
            offsets
                .signature_offset
                .checked_sub(message_offset)
                .unwrap(),
        );
        let end = start
            .checked_add(SIGNATURE_LEN.into())
            .ok_or(SignatureVerificationError::InvalidSignatureOffset)?;
        &msg[start..end].try_into().unwrap()
    };

    let payload =
        hex::decode(payload).map_err(|_| SignatureVerificationError::InvalidMessageHex)?;
    Ok(VerifiedMessage {
        swift_order_params_message: SwiftOrderParamsMessage::deserialize(
            &mut &payload[8..], // 8 byte manual discriminator
        )
        .unwrap(),
        signature: *signature,
    })
}

#[error_code]
#[derive(PartialEq, Eq)]
pub enum SignatureVerificationError {
    #[msg("invalid ed25519 instruction program")]
    InvalidEd25519InstructionProgramId,
    #[msg("invalid ed25519 instruction data length")]
    InvalidEd25519InstructionDataLength,
    #[msg("invalid signature index")]
    InvalidSignatureIndex,
    #[msg("invalid signature offset")]
    InvalidSignatureOffset,
    #[msg("invalid public key offset")]
    InvalidPublicKeyOffset,
    #[msg("invalid message offset")]
    InvalidMessageOffset,
    #[msg("invalid message data size")]
    InvalidMessageDataSize,
    #[msg("invalid instruction index")]
    InvalidInstructionIndex,
    #[msg("message offset overflow")]
    MessageOffsetOverflow,
    #[msg("invalid message hex")]
    InvalidMessageHex,
}
