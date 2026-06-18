import { OptionValues, Command } from 'commander';
import { getCommandContext } from '../utils';
import { VaultDepositorRecord } from '../../src';
import { BN, TEN, convertToNumber, getVariant } from '@velocity-exchange/sdk';

export const decodeLogs = async (program: Command, cmdOpts: OptionValues) => {
	let txId: string;
	try {
		txId = cmdOpts.tx as string;
	} catch (err) {
		console.error('Invalid transaction hash');
		process.exit(1);
	}
	if (!txId) {
		console.error('Invalid transaction hash');
		process.exit(1);
	}

	const { driftVault, driftClient } = await getCommandContext(program, false);

	const tx = await driftClient.connection.getParsedTransaction(txId, {
		commitment: 'confirmed',
		maxSupportedTransactionVersion: 0,
	});

	let i = 0;
	// @ts-ignore
	for (const event of driftVault.program._events._eventParser.parseLogs(
		tx!.meta!.logMessages
	)) {
		console.log(`--------------- Event: ${i} ${event.name} -----------------`);
		i++;

		/* eslint-disable no-case-declarations */
		switch (event.name) {
			case 'VaultDepositorRecord':
				const data: VaultDepositorRecord = event.data;
				const spotMarket = driftClient.getSpotMarketAccount(
					data.spotMarketIndex
				);
				const spotPrecision = TEN.pow(new BN(spotMarket!.decimals));
				const date = new Date(data.ts.toNumber() * 1000);

				console.log(event.name);
				console.log(` ts: ${date.toISOString()} (${data.ts.toNumber()})`);
				console.log(` vault:              ${data.vault.toBase58()}`);
				console.log(
					` depositorAuthority: ${data.depositorAuthority.toBase58()}`
				);
				console.log(` action: ${getVariant(data.action)}`);
				console.log(` amount: ${convertToNumber(data.amount, spotPrecision)}`);
				console.log(` vaultSharesBefore: ${data.vaultSharesBefore.toNumber()}`);
				console.log(
					` vaultSharesAfter:  ${data.vaultSharesAfter.toNumber()} (${
						data.vaultSharesAfter.toNumber() - data.vaultSharesBefore.toNumber()
					})`
				);
				console.log(
					` vaultEquityBefore:     ${convertToNumber(
						data.vaultEquityBefore,
						spotPrecision
					)}`
				);
				console.log(
					` userVaultSharesBefore: ${data.userVaultSharesBefore.toNumber()}`
				);
				console.log(
					` userVaultSharesAfter:  ${data.userVaultSharesAfter.toNumber()} (${
						data.userVaultSharesAfter.toNumber() -
						data.userVaultSharesBefore.toNumber()
					})`
				);
				console.log(
					` totalVaultSharesBefore: ${data.totalVaultSharesBefore.toNumber()}`
				);
				console.log(
					` totalVaultSharesAfter:  ${data.totalVaultSharesAfter.toNumber()} (${
						data.totalVaultSharesAfter.toNumber() -
						data.totalVaultSharesBefore.toNumber()
					})`
				);
				console.log(` profitShare:    ${data.profitShare.toNumber()}`);
				console.log(` managementFee:  ${data.managementFee.toNumber()}`);
				console.log(
					` managementFeeShares:  ${data.managementFeeShares.toNumber()}`
				);
				// @ts-ignore
				console.log(
					` depositOraclePrice:  ${data.depositOraclePrice?.toNumber()}`
				);
				break;
			default:
		}

		console.log('----------Raw Event-------------');
		console.log(event);
	}
};
