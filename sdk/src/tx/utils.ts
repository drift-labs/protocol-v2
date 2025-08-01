import {
	AddressLookupTableAccount,
	Transaction,
	TransactionInstruction,
	VersionedTransaction,
} from '@solana/web3.js';

export const MAX_TX_BYTE_SIZE = 1232;
export const NATIVE_INSTRUCTION_MAGIC_BYTES = [0xff, 0xff, 0xff, 0xff];

export const isVersionedTransaction = (
	tx: Transaction | VersionedTransaction
): boolean => {
	const version = (tx as VersionedTransaction)?.version;
	const isVersionedTx =
		tx instanceof VersionedTransaction || version !== undefined;

	return isVersionedTx;
};

export const getSizeOfTransaction = (
	instructions: TransactionInstruction[],
	versionedTransaction = true,
	addressLookupTables: AddressLookupTableAccount[] = []
): number => {
	const programs = new Set<string>();
	const signers = new Set<string>();
	let accounts = new Set<string>();

	instructions.forEach((ix) => {
		try {
			if (ix.programId) {
				programs.add(ix.programId.toBase58());
				accounts.add(ix.programId.toBase58());
			}
			if (ix.keys) {
				ix.keys.forEach((key) => {
					if (key.isSigner) {
						signers.add(key.pubkey.toBase58());
					}
					accounts.add(key.pubkey.toBase58());
				});
			}
		} catch (e) {
			console.log(e);
		}
	});

	const instructionSizes: number = instructions
		.map(
			(ix) =>
				1 +
				getSizeOfCompressedU16(ix.keys.length) +
				ix.keys.length +
				getSizeOfCompressedU16(ix.data.length) +
				ix.data.length
		)
		.reduce((a, b) => a + b, 0);

	let numberOfAddressLookups = 0;
	if (addressLookupTables.length > 0) {
		const lookupTableAddresses = addressLookupTables
			.map((addressLookupTable) =>
				addressLookupTable.state.addresses.map((address) => address.toBase58())
			)
			.flat();
		const totalNumberOfAccounts = accounts.size;
		accounts = new Set(
			[...accounts].filter((account) => !lookupTableAddresses.includes(account))
		);
		accounts = new Set([...accounts, ...programs, ...signers]);
		numberOfAddressLookups = totalNumberOfAccounts - accounts.size;
	}

	return (
		getSizeOfCompressedU16(signers.size) +
		signers.size * 64 + // array of signatures
		3 +
		getSizeOfCompressedU16(accounts.size) +
		32 * accounts.size + // array of account addresses
		32 + // recent blockhash
		getSizeOfCompressedU16(instructions.length) +
		instructionSizes + // array of instructions
		(versionedTransaction ? 1 + getSizeOfCompressedU16(0) : 0) +
		(versionedTransaction ? 32 * addressLookupTables.length : 0) +
		(versionedTransaction && addressLookupTables.length > 0 ? 2 : 0) +
		numberOfAddressLookups
	);
};

function getSizeOfCompressedU16(n: number) {
	return 1 + Number(n >= 128) + Number(n >= 16384);
}

export function createNativeInstructionDiscriminatorBuffer(
	discriminator: number
): Uint8Array {
	const buffer = new Uint8Array(5);
	buffer.set(NATIVE_INSTRUCTION_MAGIC_BYTES, 0);
	buffer.set([discriminator], 4);
	return buffer;
}
