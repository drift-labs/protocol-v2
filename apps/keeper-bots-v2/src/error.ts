import { SendTransactionError, TransactionError } from '@solana/web3.js';
import { ExtendedTransactionError } from './utils';

export function getErrorCode(error: Error): number | undefined {
	// @ts-ignore
	let errorCode = error.code;

	if (!errorCode) {
		try {
			const matches = error.message.match(
				/custom program error: (0x[0-9,a-f]+)/
			);
			if (!matches) {
				return undefined;
			}

			const code = matches[1];

			if (code) {
				errorCode = parseInt(code, 16);
			}
		} catch (e) {
			// no problem if couldn't match error code
		}
	}
	return errorCode;
}

export function getErrorMessage(error: SendTransactionError): string {
	let errorString = '';
	error.logs?.forEach((logMsg) => {
		try {
			const matches = logMsg.match(
				/Program log: AnchorError occurred. Error Code: ([0-9,a-z,A-Z]+). Error Number/
			);
			if (!matches) {
				return;
			}
			const errorCode = matches[1];

			if (errorCode) {
				errorString = errorCode;
			}
		} catch (e) {
			// no problem if couldn't match error code
		}
	});

	return errorString;
}

type CustomError = {
	Custom: number;
};

export function getErrorCodeFromSimError(
	error: TransactionError | string | null
): number | null {
	if ((error as ExtendedTransactionError).InstructionError === undefined) {
		return null;
	}
	const err = (error as ExtendedTransactionError).InstructionError;
	if (!err) {
		return null;
	}

	if (err.length < 2) {
		console.error(`sim error has no error code. ${JSON.stringify(error)}`);
		return null;
	}
	if (!err[1]) {
		return null;
	}

	if (typeof err[1] === 'object' && 'Custom' in err[1]) {
		return Number((err[1] as CustomError).Custom);
	}

	return null;
}
