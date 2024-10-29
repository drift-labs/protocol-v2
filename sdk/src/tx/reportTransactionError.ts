import {
	Commitment,
	Connection,
	Finality,
	SendTransactionError,
	VersionedTransactionResponse,
} from '@solana/web3.js';
import { DEFAULT_CONFIRMATION_OPTS } from '../config';

/**
 * The new getTransaction method expects a Finality type instead of a Commitment type. The only options for Finality are 'confirmed' and 'finalized'.
 * @param commitment
 * @returns
 */
const commitmentToFinality = (commitment: Commitment): Finality => {
	switch (commitment) {
		case 'confirmed':
			return 'confirmed';
		case 'finalized':
			return 'finalized';
		default:
			throw new Error(
				`Invalid commitment when reporting transaction error. The commitment must be 'confirmed' or 'finalized' but was given '${commitment}'. If you're using this commitment for a specific reason, you may need to roll your own logic here.`
			);
	}
};

const getTransactionResult = async (
	txSig: string,
	connection: Connection,
	commitment?: Commitment
): Promise<VersionedTransactionResponse> => {
	const finality = commitmentToFinality(
		commitment || connection.commitment || DEFAULT_CONFIRMATION_OPTS.commitment
	);
	return await connection.getTransaction(txSig, {
		maxSupportedTransactionVersion: 0,
		commitment: finality,
	});
};

const getTransactionResultWithRetry = async (
	txSig: string,
	connection: Connection,
	commitment?: Commitment
): Promise<VersionedTransactionResponse> => {
	const start = Date.now();

	const retryTimeout = 3_000; // Timeout after 3 seconds
	const retryInterval = 800; // Retry with 800ms interval
	const retryCount = 3; // Retry 3 times

	let currentCount = 0;
	let transactionResult = await getTransactionResult(
		txSig,
		connection,
		commitment
	);

	// Retry 3 times or until timeout as long as we don't have a result yet
	while (
		!transactionResult &&
		Date.now() - start < retryTimeout &&
		currentCount < retryCount
	) {
		// Sleep for 1 second :: Do this first so that we don't run the first loop immediately after the initial fetch above
		await new Promise((resolve) => setTimeout(resolve, retryInterval));

		transactionResult = await getTransactionResult(
			txSig,
			connection,
			commitment
		);
		currentCount++;
	}

	return transactionResult;
};

/**
 * THROWS if there is an error
 *
 * Should only be used for a txSig that is confirmed has an error. There is a race-condition where sometimes the transaction is not instantly available to fetch after the confirmation has already failed with an error, so this method has retry logic which we don't want to do wastefully. This method will throw a generic error if it can't get the transaction result after a retry period.
 * @param txSig
 * @param connection
 * @returns
 */
export const throwTransactionError = async (
	txSig: string,
	connection: Connection,
	commitment?: Commitment
): Promise<void> => {
	const err = await getTransactionErrorFromTxSig(txSig, connection, commitment);

	if (err) {
		throw err;
	}

	return;
};

/**
 * RETURNS an error if there is one
 *
 * Should only be used for a txSig that is confirmed has an error. There is a race-condition where sometimes the transaction is not instantly available to fetch after the confirmation has already failed with an error, so this method has retry logic which we don't want to do wastefully. This method will throw a generic error if it can't get the transaction result after a retry period.
 * @param txSig
 * @param connection
 * @returns
 */
export const getTransactionErrorFromTxSig = async (
	txSig: string,
	connection: Connection,
	commitment?: Commitment
): Promise<SendTransactionError> => {
	const transactionResult = await getTransactionResultWithRetry(
		txSig,
		connection,
		commitment
	);

	if (!transactionResult) {
		// Throw a generic error because we couldn't get the transaction result for the given txSig
		return new SendTransactionError({
			action: 'send',
			signature: txSig,
			transactionMessage: `Transaction Failed`,
		});
	}

	if (!transactionResult?.meta?.err) {
		// Assume that the transaction was successful and we are here erroneously because we have a result with no error
		return;
	}

	return getTransactionError(transactionResult);
};

export const getTransactionError = (
	transactionResult: VersionedTransactionResponse
): SendTransactionError => {
	if (!transactionResult?.meta?.err) {
		return;
	}

	const logs = transactionResult?.meta?.logMessages ?? ['No logs'];

	const lastLog = logs[logs.length - 1];

	const friendlyMessage = lastLog?.match(/(failed:) (.+)/)?.[2];

	return new SendTransactionError({
		action: 'send',
		signature: transactionResult?.transaction?.signatures?.[0],
		transactionMessage: `Transaction Failed${
			friendlyMessage ? `: ${friendlyMessage}` : ''
		}`,
		logs,
	});
};
