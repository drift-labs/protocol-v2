use crate::error::ErrorCode;
use anchor_lang::prelude::*;
use solana_program::ed25519_program::ID as ED25519_ID;
use solana_program::instruction::Instruction;
use std::convert::TryInto;

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

/// Check Ed25519Program instruction data verifies the given digest
///
/// `ix` an Ed25519Program instruction [see](https://github.com/solana-labs/solana/blob/master/sdk/src/ed25519_instruction.rs))
///
/// `digest` expected digest signed by the offchain client i.e 'sha256(appMessage.serialize())'
///
/// `pubkey` expected pubkey of the signer
///
pub fn verify_ed25519_digest(ix: &Instruction, pubkey: &[u8; 32], digest: &[u8; 32]) -> Result<()> {
    if ix.program_id != ED25519_ID || ix.accounts.len() != 0 {
        msg!("Invalid Ix: program ID: {:?}", ix.program_id);
        msg!("Invalid Ix: accounts: {:?}", ix.accounts.len());
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    let ix_data = &ix.data;
    // According to this layout used by the Ed25519Program]
    if ix_data.len() <= 112 {
        msg!(
            "Invalid Ix: data: {:?}, len: {:?}",
            ix.data.len(),
            16 + 64 + 32 + digest.len()
        );
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    // Check the ed25519 verify ix header is sound
    let num_signatures = ix_data[0];
    let padding = ix_data[1];
    let signature_offset = u16::from_le_bytes(ix_data[2..=3].try_into().unwrap());
    let signature_instruction_index = u16::from_le_bytes(ix_data[4..=5].try_into().unwrap());
    let public_key_offset = u16::from_le_bytes(ix_data[6..=7].try_into().unwrap());
    let public_key_instruction_index = u16::from_le_bytes(ix_data[8..=9].try_into().unwrap());
    let message_data_offset = u16::from_le_bytes(ix_data[10..=11].try_into().unwrap());
    let message_data_size = u16::from_le_bytes(ix_data[12..=13].try_into().unwrap());
    let message_instruction_index = u16::from_le_bytes(ix_data[14..=15].try_into().unwrap());

    // Expected values
    let exp_public_key_offset: u16 = 16;
    let exp_signature_offset: u16 = exp_public_key_offset + 32_u16;
    let exp_message_data_offset: u16 = exp_signature_offset + 64_u16;
    let exp_num_signatures: u8 = 1;

    // Header
    if num_signatures != exp_num_signatures
        || padding != 0
        || signature_offset != exp_signature_offset
        || signature_instruction_index != u16::MAX
        || public_key_offset != exp_public_key_offset
        || public_key_instruction_index != u16::MAX
        || message_data_offset != exp_message_data_offset
        || message_instruction_index != u16::MAX
    {
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    // verify data is for digest and pubkey
    let ix_msg_data = &ix_data[112..];
    if ix_msg_data != digest || message_data_size != digest.len() as u16 {
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    let ix_pubkey = &ix_data[16..16 + 32];
    if ix_pubkey != pubkey {
        msg!("Invalid Ix: pubkey: {:?}", ix_pubkey);
        msg!("Invalid Ix: expected pubkey: {:?}", pubkey);
        return Err(ErrorCode::SigVerificationFailed.into());
    }

    Ok(())
}

/// Extract pubkey from serialized Ed25519Program instruction data
pub fn extract_ed25519_ix_pubkey(ix_data: &[u8]) -> Result<[u8; 32]> {
    match ix_data[16..16 + 32].try_into() {
        Ok(raw) => Ok(raw),
        Err(_) => Err(ErrorCode::SigVerificationFailed.into()),
    }
}

pub fn extract_ed25519_ix_signature(ix_data: &[u8]) -> Result<[u8; 64]> {
    match ix_data[48..48 + 64].try_into() {
        Ok(raw) => Ok(raw),
        Err(_) => Err(ErrorCode::SigVerificationFailed.into()),
    }
}
