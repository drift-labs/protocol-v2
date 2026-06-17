import { PublicKey } from '@solana/web3.js';
import { OptionValues, Command } from 'commander';
import { dumpTransactionMessage, getCommandContext } from '../utils';
import {
	BN,
	PERCENTAGE_PRECISION,
	convertToNumber,
} from '@velocity-exchange/sdk';

export const managerUpdateFees = async (
	program: Command,
	cmdOpts: OptionValues
) => {
	let vaultAddress: PublicKey;
	try {
		vaultAddress = new PublicKey(cmdOpts.vaultAddress as string);
	} catch (err) {
		console.error('Invalid vault address');
		process.exit(1);
	}

	const { driftVault, driftClient } = await getCommandContext(program, true);

	const vault = await driftVault.getVault(vaultAddress);

	const timelockDuration = cmdOpts.timelockDuration;
	let timelockDurationBN: BN | null = null;
	const minTimelockDurationBN = new BN(
		Math.max(7 * 24 * 60 * 60, vault.redeemPeriod.toNumber() * 2)
	);
	if (timelockDuration !== undefined && timelockDuration !== null) {
		timelockDurationBN = new BN(parseInt(timelockDuration));
		if (timelockDurationBN.lt(minTimelockDurationBN)) {
			throw new Error(
				`Timelock duration must be at least ${minTimelockDurationBN.toNumber()} seconds`
			);
		}
	} else {
		timelockDurationBN = minTimelockDurationBN;
	}

	let managementFee = cmdOpts.managementFee;
	let managementFeeBN: BN | null = null;
	if (managementFee !== undefined && managementFee !== null) {
		managementFee = parseInt(managementFee);
		managementFeeBN = new BN(managementFee)
			.mul(PERCENTAGE_PRECISION)
			.div(new BN(100));
	}

	let profitShare = cmdOpts.profitShare;
	let profitShareNumber: number | null = null;
	if (profitShare !== undefined && profitShare !== null) {
		profitShare = parseInt(profitShare);
		profitShareNumber = (profitShare * PERCENTAGE_PRECISION.toNumber()) / 100.0;
	}

	let hurdleRate = cmdOpts.hurdleRate;
	let hurdleRateNumber: number | null = null;
	if (hurdleRate !== undefined && hurdleRate !== null) {
		hurdleRate = parseInt(hurdleRate);
		hurdleRateNumber = (hurdleRate * PERCENTAGE_PRECISION.toNumber()) / 100.0;
	}

	console.log(
		`Updating fees, effective in ${timelockDurationBN?.toNumber()} seconds`
	);

	const managementFeeBefore =
		convertToNumber(vault.managementFee, PERCENTAGE_PRECISION) * 100.0;
	const managementFeeAfter = managementFeeBN
		? `${convertToNumber(managementFeeBN, PERCENTAGE_PRECISION) * 100.0}%`
		: 'unchanged';
	console.log(
		`  ManagementFee:          ${managementFeeBefore}% -> ${managementFeeAfter}`
	);

	const profitShareBefore =
		(vault.profitShare / PERCENTAGE_PRECISION.toNumber()) * 100.0;
	const profitShareAfter =
		profitShareNumber !== null
			? `${(profitShareNumber / PERCENTAGE_PRECISION.toNumber()) * 100.0}%`
			: 'unchanged';
	console.log(
		`  ProfitShare:            ${profitShareBefore}% -> ${profitShareAfter}`
	);

	const hurdleRateBefore =
		(vault.hurdleRate / PERCENTAGE_PRECISION.toNumber()) * 100.0;
	const hurdleRateAfter =
		hurdleRateNumber !== null
			? `${(hurdleRateNumber / PERCENTAGE_PRECISION.toNumber()) * 100.0}%`
			: 'unchanged';
	console.log(
		`  HurdleRate:             ${hurdleRateBefore}% -> ${hurdleRateAfter}`
	);

	const readline = require('readline').createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	console.log('');
	const answer = await new Promise((resolve) => {
		readline.question(
			'Is the above information correct? (yes/no) ',
			(answer: string) => {
				readline.close();
				resolve(answer);
			}
		);
	});
	if ((answer as string).toLowerCase() !== 'yes') {
		console.log('Fee update canceled.');
		readline.close();
		process.exit(0);
	}
	console.log('Updating fees...');

	const newParams = {
		timelockDuration: timelockDurationBN,
		newManagementFee: managementFeeBN,
		newProfitShare: profitShareNumber,
		newHurdleRate: hurdleRateNumber,
	};

	let done = false;
	while (!done) {
		try {
			if (cmdOpts.dumpTransactionMessage) {
				const tx = await driftVault.getManagerUpdateFeesIx(
					vaultAddress,
					newParams
				);
				console.log(dumpTransactionMessage(driftClient.wallet.publicKey, [tx]));
			} else {
				const tx = await driftVault.managerUpdateFees(vaultAddress, newParams);
				console.log(
					`Updated vault fees as vault manager: https://solana.fm/tx/${tx}${
						driftClient.env === 'devnet' ? '?cluster=devnet-solana' : ''
					}`
				);
				done = true;
			}
			break;
		} catch (e) {
			const err = e as Error;
			if (err.message.includes('TransactionExpiredTimeoutError')) {
				console.log(err.message);
				console.log('Transaction timeout. Retrying...');
				await new Promise((resolve) => setTimeout(resolve, 5000));
			} else {
				throw err;
			}
		}
	}
};
