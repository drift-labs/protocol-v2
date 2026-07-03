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
 * Constructs a minimal Ed25519 verification instruction that, instead of embedding its own copy
 * of the signature/pubkey/message, points its offsets at data already present inside another
 * instruction in the same transaction (e.g. `postPythLazerOracleUpdate`, `placeSignedMsgTakerOrder`).
 * This lets the native ed25519 program verify a signature the velocity program also needs to read,
 * without duplicating the signed payload in the transaction (which would blow the size limit for
 * larger payloads like Lazer updates). The Solana runtime requires this ed25519 verify instruction
 * to be a sibling instruction (not a CPI) executed before the instruction that relies on it.
 *
 * @param customInstructionIndex The index of the custom instruction in the transaction (e.g. if tx contains compute budget limit, compute budget price, ed25519 verify, custom ix, this would be 3).
 * @param messageOffset The offset within the custom instruction data where the signed message begins.
 * @param customInstructionData The entire instruction data array for the custom instruction.
 * @param magicLen Length, in bytes, of a "magic"/tag prefix between `messageOffset` and the
 * start of the 64-byte signature; defaults to `MAGIC_LEN` (4) if omitted.
 * @returns A `TransactionInstruction` targeting `Ed25519Program` with no accounts, whose data
 * encodes offsets (not copies) of the signature/pubkey/message living inside the referenced
 * custom instruction.
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
