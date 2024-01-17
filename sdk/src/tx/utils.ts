import { Wallet } from '@coral-xyz/anchor';
import { BN, User, PreSettleOpts } from '..';
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

/* For risk increasing actions, driftClient calls this to fetch the initial ixs for the 
tx, which will include settling pnl only if enableSettleFirstMode is true and the user has 
insufficient collateral to perform the tx without settling pnl first. */
export async function getInitialIxsForRiskIncreasingAction({
	enableSettleFirstMode,
	user,
	opts,
}: {
	enableSettleFirstMode: boolean;
	user: User;
	opts: PreSettleOpts;
}): Promise<TransactionInstruction[]> {
	if (
		!enableSettleFirstMode ||
		!user?.isSubscribed ||
		!opts ||
		opts?.reduceOnlyTrade
	)
		return [];

	let settleNecessaryForTx: boolean;
	let maxWithoutSettle: BN;

	switch (opts.txType) {
		case 'withdraw':
			maxWithoutSettle = user.getWithdrawalLimit(
				opts.spotMarketIndex,
				true,
				false
			);
			settleNecessaryForTx = maxWithoutSettle.lt(opts.baseAmountRequested);
			break;
		case 'borrow':
			maxWithoutSettle = user.getWithdrawalLimit(
				opts.spotMarketIndex,
				false,
				false
			);
			settleNecessaryForTx = maxWithoutSettle.lt(opts.baseAmountRequested);
			break;
		case 'perpTrade':
			maxWithoutSettle = user.getMaxTradeSizeUSDCForPerp(
				opts.perpMarketIndex,
				opts.tradeDirection,
				false,
				false
			);
			settleNecessaryForTx = maxWithoutSettle.lt(opts.notionalValueRequested);
			break;
		case 'spotTrade':
			maxWithoutSettle = user.getMaxTradeSizeUSDCForSpot(
				opts.spotMarketIndex,
				opts.tradeDirection,
				undefined,
				undefined,
				false
			);
			settleNecessaryForTx = maxWithoutSettle.lt(opts.notionalValueRequested);
			break;
		case 'swap':
			maxWithoutSettle = user.getMaxSwapAmount({
				inMarketIndex: opts.inMarketIndex,
				outMarketIndex: opts.outMarketIndex,
				includeSettle: false,
			})?.[opts.swapMode === 'ExactIn' ? 'inAmount' : 'outAmount'];
			settleNecessaryForTx = maxWithoutSettle.lt(opts.baseAmountRequested);
			break;
	}

	if (!settleNecessaryForTx) return [];
	console.log('Pre-settle needed for action...');

	const settlePnlsIxs = await user.getSettleAllIxs();
	return settlePnlsIxs;
}
