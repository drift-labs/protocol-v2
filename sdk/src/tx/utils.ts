import { Wallet } from '@coral-xyz/anchor';
import {
	Transaction,
	TransactionInstruction,
	ComputeBudgetProgram,
	VersionedTransaction,
} from '@solana/web3.js';

const COMPUTE_UNITS_DEFAULT = 200_000;

export function wrapInTx(
	instruction: TransactionInstruction,
	computeUnits = 600_000,
	computeUnitsPrice = 0
): Transaction {
	const tx = new Transaction();
	if (computeUnits != COMPUTE_UNITS_DEFAULT) {
		tx.add(
			ComputeBudgetProgram.setComputeUnitLimit({
				units: computeUnits,
			})
		);
	}

	if (computeUnitsPrice != 0) {
		tx.add(
			ComputeBudgetProgram.setComputeUnitPrice({
				microLamports: computeUnitsPrice,
			})
		);
	}

	return tx.add(instruction);
}

/* Helper function for signing multiple transactions where some may be undefined and mapping the output */
export async function getSignedTransactionMap(
	wallet: Wallet,
	txsToSign: (Transaction | VersionedTransaction | undefined)[],
	keys: string[]
): Promise<{ [key: string]: Transaction | VersionedTransaction | undefined }> {
	const signedTxMap: {
		[key: string]: Transaction | VersionedTransaction | undefined;
	} = {};

	const keysWithTx = [];
	txsToSign.forEach((tx, index) => {
		if (tx == undefined) {
			signedTxMap[keys[index]] = undefined;
		} else {
			keysWithTx.push(keys[index]);
		}
	});

	const signedTxs = await wallet.signAllTransactions(
		txsToSign.filter((tx) => tx !== undefined)
	);

	signedTxs.forEach((signedTx, index) => {
		signedTxMap[keysWithTx[index]] = signedTx;
	});

	return signedTxMap;
}
