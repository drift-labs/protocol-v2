use anchor_client::solana_sdk::instruction::Instruction;
use anchor_client::solana_sdk::secp256k1_program;

// Constants per Solana's secp256k1 instruction specification:
const SIGNATURE_SERIALIZED_SIZE: usize = 64;
const HASHED_PUBKEY_SERIALIZED_SIZE: usize = 20;
const SIGNATURE_OFFSETS_SERIALIZED_SIZE: usize = 11;

/// This struct holds a single secp256k1 signature bundle.
#[derive(Clone)]
pub struct SecpSignature {
    pub signature: [u8; SIGNATURE_SERIALIZED_SIZE],
    pub recovery_id: u8,
    pub eth_address: [u8; HASHED_PUBKEY_SERIALIZED_SIZE],
    pub message: Vec<u8>,
}

pub struct Secp256k1InstructionUtils;

impl Secp256k1InstructionUtils {
    /// Builds a secp256k1 verification instruction using the provided signatures.
    ///
    /// # Arguments
    ///
    /// * `signatures` - A slice of [`SecpSignature`] which must all share the same message.
    /// * `instruction_index` - The instruction index to encode (usually 0).
    ///
    /// # Returns
    ///
    /// A [`Result`] with the constructed [`Instruction`] on success.
    pub fn build_secp256k1_instruction(
        signatures: &[SecpSignature],
        instruction_index: u8,
    ) -> Result<Instruction, Box<dyn std::error::Error>> {
        // Use your function to produce the raw instruction data.
        let data = make_secp256k1_instruction_data_unique_message(signatures, instruction_index)?;
        Ok(Instruction {
            program_id: secp256k1_program::ID,
            accounts: vec![],
            data,
        })
    }
}

/// Constructs secp256k1 instruction data that bundles multiple signatures with a single common message.
pub fn make_secp256k1_instruction_data_unique_message(
    signatures: &[SecpSignature],
    instruction_index: u8,
) -> std::result::Result<Vec<u8>, Box<dyn std::error::Error>> {
    if signatures.is_empty() {
        return Err("No signatures provided".into());
    }
    // Ensure that every signature in the slice has the same message.
    let common_message = &signatures[0].message;
    for sig in signatures.iter() {
        if sig.message != *common_message {
            return Err("Not all signatures share the same message".into());
        }
    }
    let message_size = common_message.len();
    // For each signature block, we now only include:
    // - Signature (64 bytes)
    // - Recovery ID (1 byte)
    // - Ethereum address (20 bytes)
    // Total = 85 bytes per signature.
    let signature_block_size = SIGNATURE_SERIALIZED_SIZE + 1 + HASHED_PUBKEY_SERIALIZED_SIZE;
    let count = signatures.len();
    // The offsets area comes first: 1 byte for count + count * 11 bytes.
    let offsets_area_size = 1 + count * SIGNATURE_OFFSETS_SERIALIZED_SIZE;
    // The signature blocks will take up count * signature_block_size bytes.
    // Then, we append the common message once.
    // The message offset (for every signature) will be the same, equal to:
    let message_offset = offsets_area_size + count * signature_block_size;

    let mut signature_offsets = Vec::with_capacity(count);
    let mut signature_buffer = Vec::new();

    for sig in signatures {
        // For this signature block, compute its starting offset relative to the start of the instruction data.
        let current_offset = offsets_area_size + signature_buffer.len();
        let signature_offset = current_offset; // where the 64-byte signature begins
        let eth_address_offset = current_offset + SIGNATURE_SERIALIZED_SIZE + 1; // after signature and recovery id

        // The message is stored only once (after all signature blocks).
        let message_data_offset = message_offset;
        let message_data_size = message_size; // size of the common message

        // Convert to u16
        let signature_offset = u16::try_from(signature_offset)?;
        let eth_address_offset = u16::try_from(eth_address_offset)?;
        let message_data_offset = u16::try_from(message_data_offset)?;
        let message_data_size = u16::try_from(message_data_size)?;

        let mut offsets_bytes = Vec::with_capacity(SIGNATURE_OFFSETS_SERIALIZED_SIZE);
        offsets_bytes.extend(&signature_offset.to_le_bytes());
        offsets_bytes.push(instruction_index); // signature_instruction_index
        offsets_bytes.extend(&eth_address_offset.to_le_bytes());
        offsets_bytes.push(instruction_index); // eth_address_instruction_index
        offsets_bytes.extend(&message_data_offset.to_le_bytes());
        offsets_bytes.extend(&message_data_size.to_le_bytes());
        offsets_bytes.push(instruction_index); // message_instruction_index

        if offsets_bytes.len() != SIGNATURE_OFFSETS_SERIALIZED_SIZE {
            return Err("Invalid offsets length".into());
        }
        signature_offsets.push(offsets_bytes);

        // Append the signature block (without the message)
        signature_buffer.extend(&sig.signature);
        signature_buffer.push(sig.recovery_id);
        signature_buffer.extend(&sig.eth_address);
        // Do not append the message here.
    }

    // Build the final instruction data:
    // 1. Count byte
    let mut instr_data = vec![count as u8];
    // 2. Offsets area
    for offs in signature_offsets {
        instr_data.extend(offs);
    }
    // 3. Signature blocks
    instr_data.extend(signature_buffer);
    // 4. Common message (only one copy)
    instr_data.extend(common_message);

    Ok(instr_data)
}
