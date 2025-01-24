import { TransactionInstruction, Ed25519Program } from '@solana/web3.js';
import * as BufferLayout from '@solana/buffer-layout';

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

const ED25519_INSTRUCTION_LEN = 16;
const SIGNATURE_LEN = 64;
const PUBKEY_LEN = 32;
const MAGIC_LEN = 4;
const MESSAGE_SIZE_LEN = 2;

export function getEd25519ArgsFromHex(
	hex: string,
	customInstructionIndex?: number
): {
	publicKey: Uint8Array;
	signature: Uint8Array;
	message: Uint8Array;
	instructionIndex?: number;
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
		instructionIndex: customInstructionIndex,
	};
}

const readUint16LE = (data: Uint8Array, offset: number) => {
	return data[offset] | (data[offset + 1] << 8);
};

const ED25519_INSTRUCTION_LAYOUT = BufferLayout.struct<
	Readonly<{
		messageDataOffset: number;
		messageDataSize: number;
		messageInstructionIndex: number;
		numSignatures: number;
		padding: number;
		publicKeyInstructionIndex: number;
		publicKeyOffset: number;
		signatureInstructionIndex: number;
		signatureOffset: number;
	}>
>([
	BufferLayout.u8('numSignatures'),
	BufferLayout.u8('padding'),
	BufferLayout.u16('signatureOffset'),
	BufferLayout.u16('signatureInstructionIndex'),
	BufferLayout.u16('publicKeyOffset'),
	BufferLayout.u16('publicKeyInstructionIndex'),
	BufferLayout.u16('messageDataOffset'),
	BufferLayout.u16('messageDataSize'),
	BufferLayout.u16('messageInstructionIndex'),
]);

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
	customInstructionData: Uint8Array,
	magicLen?: number
): TransactionInstruction {
	const signatureOffset =
		messageOffset + (magicLen === undefined ? MAGIC_LEN : magicLen);
	const publicKeyOffset = signatureOffset + SIGNATURE_LEN;
	const messageDataSizeOffset = publicKeyOffset + PUBKEY_LEN;
	const messageDataOffset = messageDataSizeOffset + MESSAGE_SIZE_LEN;

	const messageDataSize = readUint16LE(
		customInstructionData,
		messageDataSizeOffset - messageOffset
	);

	const instructionData = Buffer.alloc(ED25519_INSTRUCTION_LEN);

	ED25519_INSTRUCTION_LAYOUT.encode(
		{
			numSignatures: 1,
			padding: 0,
			signatureOffset,
			signatureInstructionIndex: customInstructionIndex,
			publicKeyOffset,
			publicKeyInstructionIndex: customInstructionIndex,
			messageDataOffset,
			messageDataSize: messageDataSize,
			messageInstructionIndex: customInstructionIndex,
		},
		instructionData
	);

	return new TransactionInstruction({
		keys: [],
		programId: Ed25519Program.programId,
		data: instructionData,
	});
}
