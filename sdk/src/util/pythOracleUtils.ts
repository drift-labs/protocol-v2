import {
	SYSVAR_INSTRUCTIONS_PUBKEY,
	TransactionInstruction,
	Ed25519Program,
} from '@solana/web3.js';

export function trimFeedId(feedId: string): string {
	if (feedId.startsWith('0x')) {
		return feedId.slice(2);
	}
	return feedId;
}

export function getFeedIdUint8Array(feedId: string): Uint8Array {
	const trimmedFeedId = trimFeedId(feedId);
	return Uint8Array.from(Buffer.from(trimmedFeedId, 'hex'));
}

const SIGNATURE_LEN = 64;
const PUBKEY_LEN = 32;
const MAGIC_LEN = 4;
const MESSAGE_SIZE_LEN = 2;

export function getEd25519ArgsFromHex(hex: string): {
	publicKey: Uint8Array;
	signature: Uint8Array;
	message: Uint8Array;
} {
	const cleanedHex = hex.startsWith('0x') ? hex.slice(2) : hex;
	const buffer = new Uint8Array(Buffer.from(cleanedHex, 'hex'));

	const signatureOffset = MAGIC_LEN;
	const publicKeyOffset = signatureOffset + SIGNATURE_LEN;
	const messageDataSizeOffset = publicKeyOffset + PUBKEY_LEN;
	const messageDataOffset = messageDataSizeOffset + MESSAGE_SIZE_LEN;

	const signature = buffer.slice(
		signatureOffset,
		signatureOffset + SIGNATURE_LEN
	);
	const publicKey = buffer.slice(publicKeyOffset, publicKeyOffset + PUBKEY_LEN);
	const messageSize =
		buffer[messageDataSizeOffset] | (buffer[messageDataSizeOffset + 1] << 8);
	const message = buffer.slice(
		messageDataOffset,
		messageDataOffset + messageSize
	);

	if (publicKey.length !== PUBKEY_LEN) {
		throw new Error('Invalid public key length');
	}

	if (signature.length !== SIGNATURE_LEN) {
		throw new Error('Invalid signature length');
	}

	return {
		publicKey,
		signature,
		message,
	};
}

/**
 * Constructs a minimal Ed25519 verification instruction that references the data
 * inside the main instruction (postPythLazerOracleUpdate).
 *
 * @param customInstructionIndex The index of the custom instruction in the transaction (typically 1 if this is second).
 * @param messageOffset The offset within the custom instruction data where the pythMessage begins.
 * @param customInstructionData The entire instruction data array for the custom instruction.
 */
export function createMinimalEd25519VerifyIx(
	customInstructionIndex: number,
	messageOffset: number,
	customInstructionData: Uint8Array
): TransactionInstruction {
	const signatureOffset = messageOffset + MAGIC_LEN;
	const publicKeyOffset = signatureOffset + SIGNATURE_LEN;
	const messageDataSizeOffset = publicKeyOffset + PUBKEY_LEN;
	const messageDataOffset = messageDataSizeOffset + MESSAGE_SIZE_LEN;

	if (messageDataOffset > customInstructionData.length) {
		throw new Error('Not enough data in main instruction to read message size');
	}

	const messageSize =
		customInstructionData[messageDataSizeOffset] |
		(customInstructionData[messageDataSizeOffset + 1] << 8);

	// Construct Ed25519SignatureOffsets
	// struct Ed25519SignatureOffsets (14 bytes):
	// u16 signature_offset
	// u16 signature_instruction_index
	// u16 public_key_offset
	// u16 public_key_instruction_index
	// u16 message_data_offset
	// u16 message_data_size
	// u16 message_instruction_index
	const offsets = new Uint8Array(14);
	const dv = new DataView(offsets.buffer);

	let byteOffset = 0;
	dv.setUint16(byteOffset, signatureOffset, true);
	byteOffset += 2;
	dv.setUint16(byteOffset, customInstructionIndex, true);
	byteOffset += 2;
	dv.setUint16(byteOffset, publicKeyOffset, true);
	byteOffset += 2;
	dv.setUint16(byteOffset, customInstructionIndex, true);
	byteOffset += 2;
	dv.setUint16(byteOffset, messageDataOffset, true);
	byteOffset += 2;
	dv.setUint16(byteOffset, messageSize, true);
	byteOffset += 2;
	dv.setUint16(byteOffset, customInstructionIndex, true);
	byteOffset += 2;

	const numSignatures = 1;
	const padding = 0;
	const ixData = new Uint8Array(2 + offsets.length);
	ixData[0] = numSignatures;
	ixData[1] = padding;
	ixData.set(offsets, 2);

	return new TransactionInstruction({
		keys: [
			{
				pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
				isSigner: false,
				isWritable: false,
			},
		],
		programId: Ed25519Program.programId,
		data: Buffer.from(ixData),
	});
}
