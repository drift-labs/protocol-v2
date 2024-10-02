import { Connection, SendTransactionError, VersionedTransactionResponse } from "@solana/web3.js";

const getTransactionResult = async (txSig: string, connection: Connection): Promise<VersionedTransactionResponse> => {
    return await connection.getTransaction(txSig, {
        maxSupportedTransactionVersion: 0,
    });
};

/**
 * This method should only be used for txsigs which we are sure have an error. The reason this txsig must have a confirmed error is because there is a rare race-condition where sometimes after awaiting a tx confirmation which has an error result, we can't immediately pull the transaction result to actually report the error. This means we have to potentially wait for a while to pull the result, which we want to avoid unless we're sure the transaction has an error for us.
 * @param txSig 
 * @param connection 
 * @returns 
 */
export const reportTransactionError = async (txSig: string, connection: Connection, timeout = 5_000): Promise<void> => {

    const start = Date.now();
    let transactionResult = await getTransactionResult(txSig, connection);

    while (!transactionResult?.meta?.err && Date.now() - start < timeout) {
        transactionResult = await getTransactionResult(txSig, connection);
        // Sleep for 1 second
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!transactionResult?.meta?.err) {
        throw new SendTransactionError({
            action: 'send',
            signature: txSig,
            transactionMessage: `Transaction Failed`,
        });
    }

    throw getTransactionError(transactionResult);
};

export const getTransactionErrorFromTxSig = async (txSig: string, connection: Connection): Promise<SendTransactionError> => {
    const transactionResult = await getTransactionResult(txSig, connection);

    if (!transactionResult?.meta?.err) {
        return;
    }

    return getTransactionError(transactionResult);
};

export const getTransactionError = (transactionResult: VersionedTransactionResponse): SendTransactionError => {
    if (!transactionResult?.meta?.err) {
        return;
    }

    const logs = transactionResult.meta.logMessages;

    const lastLog = logs[logs.length - 1];

    const friendlyMessage = lastLog?.match(/(failed:) (.+)/)?.[2];

    return new SendTransactionError({
        action: 'send',
        signature: transactionResult.transaction.signatures[0],
        transactionMessage: `Transaction Failed${
            friendlyMessage ? `: ${friendlyMessage}` : ''
        }`,
        logs,
    });
};