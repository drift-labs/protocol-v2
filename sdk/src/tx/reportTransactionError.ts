import { Connection, SendTransactionError, VersionedTransactionResponse } from "@solana/web3.js";

const getTransactionResult = async (txSig: string, connection: Connection): Promise<VersionedTransactionResponse> => {
    return await connection.getTransaction(txSig, {
        maxSupportedTransactionVersion: 0,
    });
};

export const reportTransactionError = async (txSig: string, connection: Connection): Promise<void> => {
    const transactionResult = await getTransactionResult(txSig, connection);


    if (!transactionResult?.meta?.err) {
        return;
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