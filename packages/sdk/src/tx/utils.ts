import {
	AddressLookupTableAccount,
	Transaction,
	TransactionInstruction,
	VersionedTransaction,
} from '@solana/web3.js';

/** Maximum serialized transaction size (bytes) Solana will accept over the wire — the 1232-byte MTU-derived limit shared by legacy and versioned transactions. */
export const MAX_TX_BYTE_SIZE = 1232;
/** 4-byte magic prefix identifying velocity's native (non-Anchor) entrypoint instructions, followed by a 1-byte opcode — see `createNativeInstructionDiscriminatorBuffer`. */
export const NATIVE_INSTRUCTION_MAGIC_BYTES = [0xff, 0xff, 0xff, 0xff];

/**
 * Checks whether a transaction is a `VersionedTransaction` (v0+) rather than a legacy `Transaction`.
 * @param tx - Transaction to check.
 * @returns `true` if `tx` is versioned.
 */
export const isVersionedTransaction = (
	tx: Transaction | VersionedTransaction
): boolean => {
	const version = (tx as VersionedTransaction)?.version;
	const isVersionedTx =
		tx instanceof VersionedTransaction || version !== undefined;

	return isVersionedTx;
};

/**
 * Estimates the serialized wire size (bytes) a transaction built from `instructions` would have,
 * without actually building/signing it — used to decide whether instructions still fit under
 * `MAX_TX_BYTE_SIZE` before committing to a blockhash/signature. Accounts for account
 * deduplication and, for versioned transactions, the byte savings from any accounts resolvable via
 * `addressLookupTables`.
 * @param instructions - Instructions the transaction would contain.
 * @param versionedTransaction - Whether to size as a v0 `VersionedTransaction` (includes the
 * version byte and lookup-table address/index overhead) or a legacy `Transaction`; defaults to `true`.
 * @param addressLookupTables - Lookup tables to credit toward reducing the static account-keys list.
 * @returns The estimated total transaction size in bytes.
 */
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
	// Filter out null/undefined lookup tables before accessing .state
	const validLookupTables = addressLookupTables.filter(
		(table): table is AddressLookupTableAccount =>
			table !== null && table !== undefined
	);
	if (validLookupTables.length > 0) {
		const lookupTableAddresses = validLookupTables
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

/**
 * Builds the 5-byte instruction-data prefix for velocity's native (non-Anchor) entrypoint:
 * `NATIVE_INSTRUCTION_MAGIC_BYTES` (`[0xFF, 0xFF, 0xFF, 0xFF]`) followed by a 1-byte opcode. Used
 * for high-frequency keeper instructions that bypass Anchor's instruction-dispatch overhead.
 * @param discriminator - The native instruction's opcode byte.
 * @returns The 5-byte discriminator buffer to prepend to the instruction's data.
 */
export function createNativeInstructionDiscriminatorBuffer(
	discriminator: number
): Uint8Array {
	const buffer = new Uint8Array(5);
	buffer.set(NATIVE_INSTRUCTION_MAGIC_BYTES, 0);
	buffer.set([discriminator], 4);
	return buffer;
}
