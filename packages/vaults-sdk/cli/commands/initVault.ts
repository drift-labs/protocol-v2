import {
	BN,
	PERCENTAGE_PRECISION,
	PublicKey,
	TEN,
	convertToNumber,
	decodeName,
	getSignedMsgUserAccountPublicKey,
	getUserAccountPublicKey,
} from '@velocity-exchange/sdk';
import { OptionValues, Command } from 'commander';
import { encodeName, getVaultAddressSync } from '../../src';
import { dumpTransactionMessage, getCommandContext } from '../utils';
import { VAULT_PROGRAM_ID } from '../../src/types/types';

export const initVault = async (program: Command, cmdOpts: OptionValues) => {
	const { driftClient, driftVault } = await getCommandContext(program, true);

	const newVaultName = cmdOpts.name;
	if (!newVaultName) {
		throw new Error('Must provide vault name with -n/--name');
	}
	const vaultNameBytes = encodeName(newVaultName!);

	let spotMarketIndex = cmdOpts.marketIndex;
	if (!spotMarketIndex) {
		spotMarketIndex = '0';
	}
	spotMarketIndex = parseInt(spotMarketIndex);
	const spotMarket = driftClient.getSpotMarketAccount(spotMarketIndex);
	if (!spotMarket) {
		throw new Error('No spot market found');
	}
	const spotPrecision = TEN.pow(new BN(spotMarket.decimals));
	const spotMarketName = decodeName(spotMarket.name);

	let redeemPeriodSec = cmdOpts.redeemPeriod;
	if (!redeemPeriodSec) {
		redeemPeriodSec = (7 * 60 * 60 * 24).toString(); // 7 days
	}
	redeemPeriodSec = parseInt(redeemPeriodSec);

	let maxTokens = cmdOpts.maxTokens;
	if (!maxTokens) {
		maxTokens = '0';
	}
	maxTokens = parseInt(maxTokens);
	const maxTokensBN = new BN(maxTokens).mul(spotPrecision);

	let managementFee = cmdOpts.managementFee;
	if (!managementFee) {
		managementFee = '0';
	}
	managementFee = parseInt(managementFee);
	const managementFeeBN = new BN(managementFee)
		.mul(PERCENTAGE_PRECISION)
		.div(new BN(100));

	let profitShare = cmdOpts.profitShare;
	if (!profitShare) {
		profitShare = '0';
	}
	profitShare = parseInt(profitShare);
	const profitShareBN = new BN(profitShare)
		.mul(PERCENTAGE_PRECISION)
		.div(new BN(100));

	let permissioned = cmdOpts.permissioned;
	if (!permissioned) {
		permissioned = false;
	}

	let minDepositAmount = cmdOpts.minDepositAmount;
	if (!minDepositAmount) {
		minDepositAmount = '0';
	}
	minDepositAmount = parseFloat(minDepositAmount);
	const minDepositAmountBN = new BN(
		spotPrecision.toNumber() * minDepositAmount
	);

	let delegate = cmdOpts.delegate;
	if (!delegate) {
		delegate = driftClient.wallet.publicKey;
	} else {
		try {
			delegate = new PublicKey(delegate);
		} catch (err) {
			console.error(`Invalid delegate address: ${err}`);
			delegate = driftClient.wallet.publicKey;
		}
	}

	console.log(`Initializing a new vault with params:`);
	console.log(`  VaultName:              ${newVaultName}`);
	console.log(
		`  DepositSpotMarketIndex: ${spotMarketIndex} (${spotMarketName})`
	);
	console.log(
		`  MaxTokens:              ${convertToNumber(
			maxTokensBN,
			spotPrecision
		)} ${spotMarketName}`
	);
	console.log(
		`  MinDepositAmount:       ${convertToNumber(
			minDepositAmountBN,
			spotPrecision
		)} ${spotMarketName}`
	);
	console.log(
		`  ManagementFee:          ${
			convertToNumber(managementFeeBN, PERCENTAGE_PRECISION) * 100.0
		}%`
	);
	console.log(
		`  ProfitShare:            ${
			convertToNumber(profitShareBN, PERCENTAGE_PRECISION) * 100.0
		}%`
	);
	console.log(`  Permissioned:           ${permissioned}`);
	console.log(`  Delegate:               ${delegate.toBase58()}`);
	console.log(
		`  Manager:                ${
			cmdOpts.manager
				? cmdOpts.manager
				: driftClient.wallet.publicKey.toBase58()
		}`
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
		console.log('Initialization cancelled.');
		readline.close();
		process.exit(0);
	}

	const vaultAddress = getVaultAddressSync(VAULT_PROGRAM_ID, vaultNameBytes);
	const vaultDriftUser = await getUserAccountPublicKey(
		driftClient.program.programId,
		vaultAddress,
		0
	);

	const ixs = [
		await driftVault.getInitializeVaultIx({
			name: vaultNameBytes,
			spotMarketIndex,
			redeemPeriod: new BN(redeemPeriodSec),
			maxTokens: maxTokensBN,
			managementFee: managementFeeBN,
			profitShare: profitShareBN.toNumber(),
			hurdleRate: 0,
			permissioned,
			minDepositAmount: minDepositAmountBN,
			manager: cmdOpts.manager,
		}),
		await driftVault.getUpdateDelegateIx(
			vaultAddress,
			delegate,
			vaultDriftUser,
			cmdOpts.manager
		),
	];

	const signedOrdersAccountAddress = getSignedMsgUserAccountPublicKey(
		driftClient.program.programId,
		vaultAddress
	);

	let swiftUsersAccountExists = false;
	try {
		const acc = await driftClient.connection.getAccountInfo(
			signedOrdersAccountAddress
		);
		swiftUsersAccountExists = acc !== null;
	} catch (_err) {
		// Error getting account info is non-critical, default to false
	}

	if (!swiftUsersAccountExists) {
		ixs.push(
			(
				await driftClient.getInitializeSignedMsgUserOrdersAccountIx(
					vaultAddress,
					8
				)
			)[1]
		);
	}

	console.log(`New vault address will be: ${vaultAddress.toBase58()}`);
	console.log(`Setting trading delegate to: ${delegate.toBase58()}`);
	console.log('');

	if (cmdOpts.dumpTransactionMessage) {
		console.log(`Base 58 encoded transaction:`);
		console.log(
			dumpTransactionMessage(
				cmdOpts.manager
					? new PublicKey(cmdOpts.manager)
					: driftClient.wallet.publicKey,
				ixs
			)
		);
	} else {
		const initTx = await driftVault.createAndSendTxn(ixs);
		console.log(
			`Initialized vault, tx: https://solana.fm/tx/${initTx}${
				driftClient.env === 'devnet' ? '?cluster=devnet-solana' : ''
			}`
		);
	}
};
