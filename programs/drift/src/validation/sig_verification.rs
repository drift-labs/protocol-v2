use crate::error::ErrorCode;
use crate::state::order_params::{
    OrderParams, SignedMsgOrderParamsDelegateMessage, SignedMsgOrderParamsMessage,
    SignedMsgTriggerOrderParams,
};
use anchor_lang::prelude::*;
use bytemuck::try_cast_slice;
use bytemuck::{Pod, Zeroable};
use byteorder::ByteOrder;
use byteorder::LE;
use solana_program::ed25519_program::ID as ED25519_ID;
use solana_program::instruction::Instruction;
use solana_program::program_memory::sol_memcmp;
use solana_program::sysvar;
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

pub struct VerifiedMessage {
    pub signed_msg_order_params: OrderParams,
    pub sub_account_id: Option<u16>,
    pub delegate_signed_taker_pubkey: Option<Pubkey>,
    pub slot: u64,
    pub uuid: [u8; 8],
    pub take_profit_order_params: Option<SignedMsgTriggerOrderParams>,
    pub stop_loss_order_params: Option<SignedMsgTriggerOrderParams>,
    pub signature: [u8; 64],
}

fn slice_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && sol_memcmp(a, b, a.len()) == 0
}

/// Check Ed25519Program instruction data verifies the given msg
///
/// `ix` an Ed25519Program instruction [see](https://github.com/solana-labs/solana/blob/master/sdk/src/ed25519_instruction.rs))
///
/// `msg` expected msg signed by the offchain client e.g 'sha256(appMessage.serialize())' for a digest
///
/// `pubkey` expected pubkey of the signer
///
pub fn verify_and_decode_ed25519_msg(
    ed25519_ix: &Instruction,
    instructions_sysvar: &AccountInfo,
    current_ix_index: u16,
    signer: &[u8; 32],
    msg: &[u8],
    is_delegate_signer: bool,
) -> Result<VerifiedMessage> {
    if ed25519_ix.program_id != ED25519_ID || ed25519_ix.accounts.len() != 0 {
        msg!("Invalid Ix: program ID: {:?}", ed25519_ix.program_id);
        msg!("Invalid Ix: accounts: {:?}", ed25519_ix.accounts.len());
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    let ed25519_ix_data = &ed25519_ix.data;
    // According to this layout used by the Ed25519Program]
    if ed25519_ix_data.len() < 2 {
        msg!(
            "Invalid Ix, should be header len = 2. data: {:?}",
            ed25519_ix.data.len(),
        );
        return Err(SignatureVerificationError::InvalidEd25519InstructionDataLength.into());
    }

    // Parse the ix data into the offsets
    let num_signatures = ed25519_ix_data[0];
    let signature_index = 0;
    if signature_index >= num_signatures {
        return Err(SignatureVerificationError::InvalidSignatureIndex.into());
    }
    let args: &[Ed25519SignatureOffsets] =
        try_cast_slice(&ed25519_ix_data[ED25519_PROGRAM_INPUT_HEADER_LEN..]).map_err(|_| {
            msg!("Invalid Ix: failed to cast slice");
            ErrorCode::SigVerificationFailed
        })?;

    let args_len = args
        .len()
        .try_into()
        .map_err(|_| SignatureVerificationError::InvalidEd25519InstructionDataLength)?;
    if signature_index >= args_len {
        return Err(SignatureVerificationError::InvalidSignatureIndex.into());
    }

    let offsets = &args[0];
    let message_offset = offsets.signature_offset;
    if offsets.signature_offset != message_offset {
        msg!(
            "Invalid Ix: signature offset: {:?}",
            offsets.signature_offset
        );
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    let self_instruction = sysvar::instructions::load_instruction_at_checked(
        current_ix_index.into(),
        instructions_sysvar,
    )
    .map_err(|_| SignatureVerificationError::LoadInstructionAtFailed)?;

    let message_end_offset = offsets
        .message_data_offset
        .checked_add(offsets.message_data_size)
        .ok_or(SignatureVerificationError::MessageOffsetOverflow)?;
    let expected_message_data = self_instruction
        .data
        .get(usize::from(message_offset)..usize::from(message_end_offset))
        .ok_or(SignatureVerificationError::InvalidMessageOffset)?;
    if !slice_eq(expected_message_data, msg) {
        return Err(SignatureVerificationError::InvalidMessageData.into());
    }

    let expected_public_key_offset = offsets
        .signature_offset
        .checked_add(SIGNATURE_LEN)
        .ok_or(SignatureVerificationError::MessageOffsetOverflow)?;
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

    if is_delegate_signer {
        let deserialized = SignedMsgOrderParamsDelegateMessage::deserialize(
            &mut &payload[8..], // 8 byte manual discriminator
        )
        .map_err(|_| {
            msg!("Invalid message encoding for is_delegate_signer = true");
            SignatureVerificationError::InvalidMessageDataSize
        })?;

        return Ok(VerifiedMessage {
            signed_msg_order_params: deserialized.signed_msg_order_params,
            sub_account_id: None,
            delegate_signed_taker_pubkey: Some(deserialized.taker_pubkey),
            slot: deserialized.slot,
            uuid: deserialized.uuid,
            take_profit_order_params: deserialized.take_profit_order_params,
            stop_loss_order_params: deserialized.stop_loss_order_params,
            signature: *signature,
        });
    } else {
        let deserialized = SignedMsgOrderParamsMessage::deserialize(
            &mut &payload[8..], // 8 byte manual discriminator
        )
        .map_err(|_| {
            msg!("Invalid delegate message encoding for with is_delegate_signer = false");
            SignatureVerificationError::InvalidMessageDataSize
        })?;

        return Ok(VerifiedMessage {
            signed_msg_order_params: deserialized.signed_msg_order_params,
            sub_account_id: Some(deserialized.sub_account_id),
            delegate_signed_taker_pubkey: None,
            slot: deserialized.slot,
            uuid: deserialized.uuid,
            take_profit_order_params: deserialized.take_profit_order_params,
            stop_loss_order_params: deserialized.stop_loss_order_params,
            signature: *signature,
        });
    }
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
    #[msg("invalid message data")]
    InvalidMessageData,
    #[msg("loading custom ix at index failed")]
    LoadInstructionAtFailed,
}
