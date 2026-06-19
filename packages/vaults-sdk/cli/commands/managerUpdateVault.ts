import { PublicKey } from '@solana/web3.js';
import { OptionValues, Command } from 'commander';
import { dumpTransactionMessage, getCommandContext } from '../utils';
import {
	BN,
	PERCENTAGE_PRECISION,
	TEN,
	convertToNumber,
	decodeName,
} from '@velocity-exchange/sdk';

export const managerUpdateVault = async (
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

	const { velocityVault, velocityClient } = await getCommandContext(program, true);

	const vault = await velocityVault.getVault(vaultAddress);
	const spotMarket = velocityClient.getSpotMarketAccount(vault.spotMarketIndex);
	if (!spotMarket) {
		throw new Error('No spot market found');
	}
	const spotPrecision = TEN.pow(new BN(spotMarket.decimals));
	const spotMarketName = decodeName(spotMarket.name);

	let redeemPeriodSec = cmdOpts.redeemPeriod ?? null;
	let redeemPeriodBN: BN | null = null;
	if (redeemPeriodSec !== undefined && redeemPeriodSec !== null) {
		redeemPeriodSec = parseInt(redeemPeriodSec);
		redeemPeriodBN = new BN(redeemPeriodSec);
	}

	let maxTokens = cmdOpts.maxTokens;
	let maxTokensBN: BN | null = null;
	if (maxTokens !== undefined && maxTokens !== null) {
		maxTokens = parseInt(maxTokens);
		maxTokensBN = new BN(maxTokens).mul(spotPrecision);
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

	let minDepositAmount = cmdOpts.minDepositAmount;
	let minDepositAmountBN: BN | null = null;
	if (minDepositAmount !== undefined && minDepositAmount !== null) {
		minDepositAmount = parseInt(minDepositAmount);
		minDepositAmountBN = new BN(minDepositAmount).mul(spotPrecision);
	}

	console.log(`Updating params:`);
	const redeemPeriodBefore = vault.redeemPeriod.toNumber();
	const redeemPeriodAfter = redeemPeriodBN
		? redeemPeriodBN.toNumber()
		: 'unchanged';
	console.log(
		`  RedeemPeriod:           ${redeemPeriodBefore} -> ${redeemPeriodAfter}`
	);

	const maxTokensBefore = `${convertToNumber(
		vault.maxTokens,
		spotPrecision
	)} ${spotMarketName}`;
	const maxTokensAfter = maxTokensBN
		? `${convertToNumber(maxTokensBN, spotPrecision)} ${spotMarketName}`
		: 'unchanged';
	console.log(
		`  MaxTokens:              ${maxTokensBefore} -> ${maxTokensAfter}`
	);

	const minDepositAmountBefore = `${convertToNumber(
		vault.minDepositAmount,
		spotPrecision
	)} ${spotMarketName}`;
	const minDepositAmountAfter = minDepositAmountBN
		? `${convertToNumber(minDepositAmountBN, spotPrecision)} ${spotMarketName}`
		: 'unchanged';
	console.log(
		`  MinDepositAmount:       ${minDepositAmountBefore} -> ${minDepositAmountAfter}`
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

	const permissioned: boolean | null =
		cmdOpts.permissioned === null || cmdOpts.permissioned === undefined
			? null
			: JSON.parse(cmdOpts.permissioned);
	const permissionedBefore = vault.permissioned;
	const permissionedAfter = permissioned !== null ? permissioned : 'unchanged';
	console.log(
		`  Permissioned:           ${permissionedBefore} -> ${permissionedAfter}`
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
		console.log('Vault update canceled.');
		readline.close();
		process.exit(0);
	}
	console.log('Updating vault...');

	// null means unchanged
	const newParams = {
		redeemPeriod: redeemPeriodBN,
		maxTokens: maxTokensBN,
		minDepositAmount: minDepositAmountBN,
		managementFee: managementFeeBN,
		profitShare: profitShareNumber,
		hurdleRate: hurdleRateNumber,
		permissioned,
	};

	let done = false;
	while (!done) {
		try {
			if (cmdOpts.dumpTransactionMessage) {
				const tx = await velocityVault.getManagerUpdateVaultIx(
					vaultAddress,
					newParams
				);
				console.log(dumpTransactionMessage(velocityClient.wallet.publicKey, [tx]));
			} else {
				const tx = await velocityVault.managerUpdateVault(vaultAddress, newParams);
				console.log(
					`Updated vault params as vault manager: https://solana.fm/tx/${tx}${
						velocityClient.env === 'devnet' ? '?cluster=devnet-solana' : ''
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
