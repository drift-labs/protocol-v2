import { Ed25519Program, TransactionInstruction } from '@solana/web3.js';
import * as BufferLayout from '@solana/buffer-layout';

const ED25519_INSTRUCTION_LEN = 16;
const SIGNATURE_LEN = 64;
const PUBKEY_LEN = 32;
const MAGIC_LEN = 4;
const MESSAGE_SIZE_LEN = 2;

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
 * inside the drift custom instruction (e.g. postPythLazerOracleUpdate, placeSignedMsgTakerOrder).
 *
 * @param customInstructionIndex The index of the custom instruction in the transaction (e.g. if tx contains compute budget limit, compute budget price, ed25519 verify, custom ix, this would be 3).
 * @param messageOffset The offset within the custom instruction data where the signed message begins.
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
