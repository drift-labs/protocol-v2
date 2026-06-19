import { Command, OptionValues } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { BN, TEN } from '@velocity-exchange/sdk';
import { dumpTransactionMessage, getCommandContext } from '../utils';

export async function managerRepay(
	program: Command,
	cmdOpts: OptionValues
): Promise<void> {
	const {
		vaultAddress,
		repaySpotMarketIndex,
		repayAmount,
		repayValue,
		managerTokenAccount,
		dumpTransactionMessage: dumpTx,
	} = cmdOpts;

	const { velocityClient, velocityVault } = await getCommandContext(program, true);

	if (!vaultAddress) {
		throw new Error('Must provide vault address with --vault-address');
	}

	if (!repaySpotMarketIndex) {
		throw new Error(
			'Must provide repay spot market index with --repay-spot-market-index'
		);
	}

	if (!repayAmount) {
		throw new Error('Must provide repay amount with --repay-amount');
	}

	const vault = new PublicKey(vaultAddress);
	const repayIndex = parseInt(repaySpotMarketIndex);

	const repaySpotMarket = velocityClient.getSpotMarketAccount(repayIndex);
	if (!repaySpotMarket) {
		throw new Error('No repay spot market found');
	}

	const vaultAccount = await velocityVault.program.account.vault.fetch(vault);
	const depositSpotMarket = velocityClient.getSpotMarketAccount(
		vaultAccount.spotMarketIndex
	);
	if (!depositSpotMarket) {
		throw new Error('No deposit spot market found');
	}
	const depositPrecision = TEN.pow(new BN(depositSpotMarket.decimals));

	const repayPrecision = TEN.pow(new BN(repaySpotMarket.decimals));
	const repayBN = new BN(repayAmount * repayPrecision.toNumber());

	const valueBN = repayValue
		? new BN(repayValue * depositPrecision.toNumber())
		: null;

	const managerTokenAccountPubkey = managerTokenAccount
		? new PublicKey(managerTokenAccount)
		: undefined;

	try {
		if (dumpTx) {
			const ixs = await velocityVault.getManagerRepayIxs(
				vault,
				repayIndex,
				repayBN,
				valueBN,
				managerTokenAccountPubkey
			);
			console.log('Transaction Instructions:');
			console.log(dumpTransactionMessage(velocityClient.wallet.publicKey, ixs));
			return;
		}

		const txSig = await velocityVault.managerRepay(
			vault,
			repayIndex,
			repayBN,
			valueBN,
			managerTokenAccountPubkey
		);
		console.log(`Manager repay transaction signature: ${txSig}`);
		console.log(
			`Transaction: https://solana.fm/tx/${txSig}${
				velocityClient.env === 'devnet' ? '?cluster=devnet-solana' : ''
			}`
		);
	} catch (error) {
		console.error('Error repaying:', error);
		throw error;
	}
}
