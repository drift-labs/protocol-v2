import {
	AddressLookupTableAccount,
	Transaction,
	TransactionInstruction,
	VersionedTransaction,
} from '@solana/web3.js';
import { DriftClient } from '../driftClient';
import { isVariant, OracleSource } from '..';
import { HermesClient } from '@pythnetwork/hermes-client';

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

	instructions.map((ix) => {
		programs.add(ix.programId.toBase58());
		accounts.add(ix.programId.toBase58());
		ix.keys.map((key) => {
			if (key.isSigner) {
				signers.add(key.pubkey.toBase58());
			}
			accounts.add(key.pubkey.toBase58());
		});
	});

	const instruction_sizes: number = instructions
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
		instruction_sizes + // array of instructions
		(versionedTransaction ? 1 + getSizeOfCompressedU16(0) : 0) +
		(versionedTransaction ? 32 * addressLookupTables.length : 0) +
		(versionedTransaction && addressLookupTables.length > 0 ? 2 : 0) +
		numberOfAddressLookups
	);
};

export const getInstructionsWithOracleCranks = async (
	instructions: TransactionInstruction[],
	driftClient: DriftClient,
	versionedTransaction = true,
	addressLookupTables: AddressLookupTableAccount[] = [],
	oraclesToCrank: { feedId: string; oracleSource: OracleSource }[]
): Promise<TransactionInstruction[]> => {
	const originalInstructionsLength = instructions.length;
	const instructionsToAdd = [];

	const pythPullFeeds = [];
	const _switchboardFeeds = [];
	let hermesClient: HermesClient;

	for (const oracleToCrank of oraclesToCrank.filter(
		(entry) => !!entry.feedId
	)) {
		if (isPythPull(oracleToCrank.oracleSource)) {
			// init the pyth connection if it's not already
			if (!hermesClient) {
				hermesClient = new HermesClient(
					process.env.NEXT_PUBLIC_DRIFT_HERMES_URL
				);
			}

			pythPullFeeds.push(oracleToCrank.feedId);
		} else if (isVariant(oracleToCrank.oracleSource, 'switchboard')) {
			// todo
		} else if (isVariant(oracleToCrank.oracleSource, 'pythLazer')) {
			// todo
		}
	}

	if (pythPullFeeds.length) {
		const latestPriceUpdates = await hermesClient.getLatestPriceUpdates(
			pythPullFeeds,
			{ encoding: 'base64' }
		);
		console.log(
			'data pulled from hermes: ',
			latestPriceUpdates.binary?.data?.join('')
		);
		const postPythPullOracleUpdateAtomicIx =
			await driftClient.getPostPythPullOracleUpdateAtomicIxs(
				latestPriceUpdates.binary?.data?.join(''),
				pythPullFeeds,
				2
			);
		instructionsToAdd.push(postPythPullOracleUpdateAtomicIx);
	}

	if (instructionsToAdd.length === 0) {
		return instructions;
	}

	instructions.unshift(...instructionsToAdd);

	let txSize = getSizeOfTransaction(
		instructions,
		versionedTransaction,
		addressLookupTables
	);
	while (txSize > 1232 && instructions.length > originalInstructionsLength) {
		console.log('Tx too large, remove first instruction');
		instructions.shift();
		txSize = getSizeOfTransaction(
			instructions,
			versionedTransaction,
			addressLookupTables
		);
	}

	return instructions;
};

function getSizeOfCompressedU16(n: number) {
	return 1 + Number(n >= 128) + Number(n >= 16384);
}

function isPythPull(oracleSource: OracleSource): boolean {
	return (
		isVariant(oracleSource, 'pythPull') ||
		isVariant(oracleSource, 'pyth1KPull') ||
		isVariant(oracleSource, 'pyth1MPull') ||
		isVariant(oracleSource, 'pythStableCoinPull')
	);
}
